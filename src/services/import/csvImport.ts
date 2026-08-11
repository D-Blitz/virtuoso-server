// CSV import orchestrator.
//
// Two public entrypoints — preview() and commit() — share the same
// per-row pipeline:
//   1. Parse CSV → array of row objects (papaparse).
//   2. For each row, call the entity spec's parseRow() → either
//      a payload or per-row errors.
//   3. For commit(), call the spec's upsert() on each successful
//      payload; collect counts of created / updated / skipped.
//
// Preview is dry: we only run parseRow + count successes/errors.
// Commit re-parses (small cost — keeps the spec contract clean)
// then writes.
//
// Failure mode: rows with errors are kept out of the commit but
// rows that succeed still write. We do NOT atomically wrap the
// whole import in a transaction because per-row writes can be
// large (tens of thousands of rows), and partial-progress is more
// useful than all-or-nothing for the typical "fix the bad rows,
// re-run" workflow. The unique upsert keys make re-runs idempotent.

import Papa from 'papaparse';

import prisma from '../../prisma';
import { getImportSpec } from './registry';
import type {
  ImportCommitResult,
  ImportContext,
  ImportPreviewResult,
  ParsedRow,
} from './types';

const PREVIEW_ROW_CAP = 200;

type ParseCsvResult =
  | { rows: Record<string, string>[]; error?: undefined }
  | { rows?: undefined; error: string };

/**
 * Field delimiters we accept, in preference order. ',' is both the
 * default and the tie-breaker.
 *
 * ';' is here because European spreadsheets export it: in locales
 * where ',' is the decimal separator (fr, de, es, it…), Excel and
 * LibreOffice write ';'-delimited CSVs. Clients were having to
 * re-save their exports before importing.
 */
const SUPPORTED_DELIMITERS = [',', ';'] as const;

/** Used when writing (template / export) and as the detection fallback. */
export const DEFAULT_DELIMITER = ',';

/**
 * A delimiter must be exactly one character and must not collide with
 * CSV's own syntax: '"' would make quoting unparseable, and CR / LF
 * would turn every field into a new record.
 *
 * Anything else is allowed — admins occasionally have pipe- or
 * tab-separated exports, and there's no reason to second-guess them.
 */
export function isValidDelimiter(d: string): boolean {
  return d.length === 1 && d !== '"' && d !== '\r' && d !== '\n';
}

/**
 * Pick the field delimiter by counting candidates in the header line.
 *
 * We still don't hand this to papaparse's own auto-detect: it fails on
 * single-column CSVs (no delimiter to find) and surfaces a confusing
 * parse error to admins importing tags or other single-field entities.
 * Counting ourselves lets "found nothing" fall back to ',' silently,
 * which is what keeps those single-column files working.
 *
 * Characters inside double quotes are skipped, so a quoted header like
 * `"Nom, complet"` can't tip the count toward ','. Ties also fall back
 * to ',' — order in SUPPORTED_DELIMITERS decides nothing on its own.
 */
function detectDelimiter(csvText: string): string {
  const headerLine =
    csvText.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';

  const counts = new Map<string, number>(
    SUPPORTED_DELIMITERS.map((d) => [d as string, 0]),
  );
  let inQuotes = false;
  for (const ch of headerLine) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    const seen = counts.get(ch);
    if (seen !== undefined) counts.set(ch, seen + 1);
  }

  let best = ',';
  let bestCount = 0;
  for (const d of SUPPORTED_DELIMITERS) {
    const c = counts.get(d) ?? 0;
    if (c > bestCount) {
      best = d;
      bestCount = c;
    }
  }
  return best;
}

/**
 * @param delimiter explicit delimiter chosen by the admin. Omit to
 *   auto-detect from the header line — the default, so the common case
 *   stays a zero-decision upload.
 */
function parseCsv(csvText: string, delimiter?: string): ParseCsvResult {
  const trimmed = csvText.replace(/^﻿/, ''); // strip UTF-8 BOM
  const parsed = Papa.parse<Record<string, string>>(trimmed, {
    header: true,
    skipEmptyLines: 'greedy',
    delimiter: delimiter ?? detectDelimiter(trimmed),
    transformHeader: (h) => h.trim(),
  });
  if (parsed.errors.length > 0) {
    // Surface the first parse error — papaparse's row-level errors
    // are usually a single recoverable issue (e.g. mismatched quotes
    // on one row). Keep it short for display.
    const e = parsed.errors[0];
    return {
      error: `Erreur d’analyse du CSV (ligne ${
        (e.row ?? 0) + 2
      }) : ${e.message}`,
    };
  }
  return { rows: parsed.data };
}

function makeContext(organizationId: string): ImportContext {
  return {
    prisma,
    organizationId,
    referenceCache: new Map(),
  };
}

export async function previewImport(params: {
  organizationId: string;
  entityType: string;
  csvText: string;
  /** Omit to auto-detect from the header line. */
  delimiter?: string;
}): Promise<ImportPreviewResult> {
  const spec = getImportSpec(params.entityType);
  if (!spec) {
    return {
      entityType: params.entityType,
      totalRows: 0,
      validRows: 0,
      warningRows: 0,
      errorRows: 0,
      rows: [],
      globalError: `Type d’import inconnu : ${params.entityType}`,
    };
  }
  const parsed = parseCsv(params.csvText, params.delimiter);
  if (parsed.error) {
    return {
      entityType: spec.type,
      totalRows: 0,
      validRows: 0,
      warningRows: 0,
      errorRows: 0,
      rows: [],
      globalError: parsed.error,
    };
  }
  const parsedRows = parsed.rows!;
  const ctx = makeContext(params.organizationId);
  const rows: ParsedRow[] = [];
  let validRows = 0;
  let warningRows = 0;
  let errorRows = 0;
  for (let i = 0; i < parsedRows.length; i++) {
    const raw = parsedRows[i];
    const result = await spec.parseRow(raw, ctx);
    const rowNumber = i + 2; // header is line 1
    const errors = result.errors ?? [];
    const warnings = result.warnings ?? [];
    if (errors.length > 0) {
      errorRows++;
    } else if (warnings.length > 0) {
      warningRows++;
    } else {
      validRows++;
    }
    if (rows.length < PREVIEW_ROW_CAP) {
      rows.push({
        rowNumber,
        raw,
        data: errors.length === 0 ? result.data : undefined,
        errors,
        warnings,
      });
    }
  }
  return {
    entityType: spec.type,
    totalRows: parsedRows.length,
    validRows,
    warningRows,
    errorRows,
    rows,
  };
}

export async function commitImport(params: {
  organizationId: string;
  entityType: string;
  csvText: string;
  /** Omit to auto-detect from the header line. */
  delimiter?: string;
}): Promise<ImportCommitResult> {
  const spec = getImportSpec(params.entityType);
  if (!spec) {
    return {
      entityType: params.entityType,
      totalRows: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      warned: 0,
      errored: 0,
      errors: [],
      warnings: [],
    };
  }
  const parsed = parseCsv(params.csvText, params.delimiter);
  if (parsed.error) {
    return {
      entityType: spec.type,
      totalRows: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      warned: 0,
      errored: 0,
      errors: [
        { rowNumber: 0, raw: {}, errors: [parsed.error], warnings: [] },
      ],
      warnings: [],
    };
  }
  const parsedRows = parsed.rows!;
  const ctx = makeContext(params.organizationId);
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let warned = 0;
  let errored = 0;
  const errors: ParsedRow[] = [];
  const warnings: ParsedRow[] = [];
  for (let i = 0; i < parsedRows.length; i++) {
    const raw = parsedRows[i];
    const rowNumber = i + 2;
    const result = await spec.parseRow(raw, ctx);
    const rowErrors = result.errors ?? [];
    const rowWarnings = result.warnings ?? [];
    if (rowErrors.length > 0) {
      errored++;
      errors.push({
        rowNumber,
        raw,
        errors: rowErrors,
        warnings: rowWarnings,
      });
      continue;
    }
    try {
      const upserted = await spec.upsert(result.data!, ctx);
      if (upserted.action === 'created') created++;
      else if (upserted.action === 'updated') updated++;
      else skipped++;
      if (rowWarnings.length > 0) {
        warned++;
        warnings.push({
          rowNumber,
          raw,
          data: result.data,
          errors: [],
          warnings: rowWarnings,
        });
      }
    } catch (err) {
      errored++;
      errors.push({
        rowNumber,
        raw,
        errors: [
          `Erreur d’enregistrement : ${
            err instanceof Error ? err.message : String(err)
          }`,
        ],
        warnings: rowWarnings,
      });
    }
  }
  return {
    entityType: spec.type,
    totalRows: parsedRows.length,
    created,
    updated,
    skipped,
    warned,
    errored,
    errors,
    warnings,
  };
}

/**
 * Produce a CSV template for a given entity type: a header row plus
 * one example row. Admins download it, fill in their data, and
 * upload back through the same endpoint.
 */
export function buildCsvTemplate(
  entityType: string,
  delimiter: string = DEFAULT_DELIMITER,
): string | null {
  const spec = getImportSpec(entityType);
  if (!spec) return null;
  const headers = spec.columns.map((c) => c.key);
  const exampleRow = spec.columns.map((c) => c.example ?? '');
  return Papa.unparse([headers, exampleRow], { delimiter });
}

/**
 * Export every row of an entity for the current org as CSV. Round-
 * trips back through commitImport() — same column order as the
 * template, so re-importing an exported file is the natural way to
 * make bulk edits.
 */
export async function exportEntityCsv(params: {
  organizationId: string;
  entityType: string;
  /** Defaults to ','. Same picker as the template download. */
  delimiter?: string;
}): Promise<string | null> {
  const spec = getImportSpec(params.entityType);
  if (!spec) return null;
  const ctx = makeContext(params.organizationId);
  const rows = await spec.exportRows(ctx);
  const headers = spec.columns.map((c) => c.key);
  // Build a 2D array: header row, then each data row in column order.
  const matrix = [
    headers,
    ...rows.map((r) => headers.map((h) => r[h] ?? '')),
  ];
  return Papa.unparse(matrix, {
    delimiter: params.delimiter ?? DEFAULT_DELIMITER,
  });
}


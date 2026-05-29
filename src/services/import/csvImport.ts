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
import { getImportSpec, IMPORT_REGISTRY } from './registry';
import type {
  ImportCommitResult,
  ImportContext,
  ImportPreviewResult,
  ParsedRow,
} from './types';

/**
 * Topological order so a single 'all' commit imports referenced
 * entities (Location, ServiceCategory) BEFORE the ones that
 * reference them (Room, Service). Empty-cell references on the
 * dependents wouldn't resolve otherwise.
 */
const DEPENDENCY_ORDER: string[] = [
  'location',
  'tag',
  'serviceCategory',
  'term',
  'closure',
  'client',
  'facilitator',
  'room',
  'service',
];

const PREVIEW_ROW_CAP = 200;

type ParseCsvResult =
  | { rows: Record<string, string>[]; error?: undefined }
  | { rows?: undefined; error: string };

function parseCsv(csvText: string): ParseCsvResult {
  const trimmed = csvText.replace(/^﻿/, ''); // strip UTF-8 BOM
  const parsed = Papa.parse<Record<string, string>>(trimmed, {
    header: true,
    skipEmptyLines: 'greedy',
    // Explicitly set the delimiter rather than relying on auto-detect.
    // Auto-detect fails on single-column CSVs (no delimiter to find)
    // and surfaces a confusing parse error to admins importing tags
    // or single-field entities.
    delimiter: ',',
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
}): Promise<ImportPreviewResult> {
  const spec = getImportSpec(params.entityType);
  if (!spec) {
    return {
      entityType: params.entityType,
      totalRows: 0,
      validRows: 0,
      errorRows: 0,
      rows: [],
      globalError: `Type d’import inconnu : ${params.entityType}`,
    };
  }
  const parsed = parseCsv(params.csvText);
  if (parsed.error) {
    return {
      entityType: spec.type,
      totalRows: 0,
      validRows: 0,
      errorRows: 0,
      rows: [],
      globalError: parsed.error,
    };
  }
  const parsedRows = parsed.rows!;
  const ctx = makeContext(params.organizationId);
  const rows: ParsedRow[] = [];
  let validRows = 0;
  let errorRows = 0;
  for (let i = 0; i < parsedRows.length; i++) {
    const raw = parsedRows[i];
    const result = await spec.parseRow(raw, ctx);
    const rowNumber = i + 2; // header is line 1
    if (result.errors && result.errors.length > 0) {
      errorRows++;
      if (rows.length < PREVIEW_ROW_CAP) {
        rows.push({ rowNumber, raw, errors: result.errors });
      }
    } else {
      validRows++;
      if (rows.length < PREVIEW_ROW_CAP) {
        rows.push({ rowNumber, raw, data: result.data, errors: [] });
      }
    }
  }
  return {
    entityType: spec.type,
    totalRows: parsedRows.length,
    validRows,
    errorRows,
    rows,
  };
}

export async function commitImport(params: {
  organizationId: string;
  entityType: string;
  csvText: string;
}): Promise<ImportCommitResult> {
  const spec = getImportSpec(params.entityType);
  if (!spec) {
    return {
      entityType: params.entityType,
      totalRows: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      errored: 0,
      errors: [],
    };
  }
  const parsed = parseCsv(params.csvText);
  if (parsed.error) {
    return {
      entityType: spec.type,
      totalRows: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      errored: 0,
      errors: [{ rowNumber: 0, raw: {}, errors: [parsed.error] }],
    };
  }
  const parsedRows = parsed.rows!;
  const ctx = makeContext(params.organizationId);
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let errored = 0;
  const errors: ParsedRow[] = [];
  for (let i = 0; i < parsedRows.length; i++) {
    const raw = parsedRows[i];
    const rowNumber = i + 2;
    const result = await spec.parseRow(raw, ctx);
    if (result.errors && result.errors.length > 0) {
      errored++;
      errors.push({ rowNumber, raw, errors: result.errors });
      continue;
    }
    try {
      const upserted = await spec.upsert(result.data!, ctx);
      if (upserted.action === 'created') created++;
      else if (upserted.action === 'updated') updated++;
      else skipped++;
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
      });
    }
  }
  return {
    entityType: spec.type,
    totalRows: parsedRows.length,
    created,
    updated,
    skipped,
    errored,
    errors,
  };
}

/**
 * Produce a CSV template for a given entity type: a header row plus
 * one example row. Admins download it, fill in their data, and
 * upload back through the same endpoint.
 */
export function buildCsvTemplate(entityType: string): string | null {
  const spec = getImportSpec(entityType);
  if (!spec) return null;
  const headers = spec.columns.map((c) => c.key);
  const exampleRow = spec.columns.map((c) => c.example ?? '');
  return Papa.unparse([headers, exampleRow]);
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
  return Papa.unparse(matrix);
}

/**
 * Batch preview: caller passes one CSV per entity type. We run
 * each spec's previewImport() and aggregate the results, keyed by
 * type. No DB writes; safe to call repeatedly.
 */
export async function previewAll(params: {
  organizationId: string;
  payloads: Record<string, string>;
}): Promise<Record<string, ImportPreviewResult>> {
  const out: Record<string, ImportPreviewResult> = {};
  for (const type of DEPENDENCY_ORDER) {
    const csv = params.payloads[type];
    if (!csv) continue;
    out[type] = await previewImport({
      organizationId: params.organizationId,
      entityType: type,
      csvText: csv,
    });
  }
  return out;
}

/**
 * Batch commit: process the provided CSVs in dependency order so
 * references resolve. Returns a per-type result map. One entity's
 * errors do NOT block the next entity from running — each spec is
 * idempotent on its own natural key, so partial failure +
 * re-running just the failing files is the standard recovery path.
 */
export async function commitAll(params: {
  organizationId: string;
  payloads: Record<string, string>;
}): Promise<Record<string, ImportCommitResult>> {
  const out: Record<string, ImportCommitResult> = {};
  for (const type of DEPENDENCY_ORDER) {
    const csv = params.payloads[type];
    if (!csv) continue;
    out[type] = await commitImport({
      organizationId: params.organizationId,
      entityType: type,
      csvText: csv,
    });
  }
  return out;
}

/** Used by the admin UI to render an "Importer/Exporter tout" surface. */
export function listAllEntityTypes(): string[] {
  return DEPENDENCY_ORDER.filter((t) => IMPORT_REGISTRY[t] != null);
}

// ─── Unified single-CSV format ────────────────────────────────────
//
// One CSV file holds rows for every entity type. A leading `type`
// column discriminates which spec validates the row. Remaining
// columns are the union of every spec's columns — shared keys
// (`name`, `email`, `address`, etc.) live in one column that's
// filled in only by the rows whose type uses them.
//
// Export: produces one row per existing entity, in dependency
// order, with empty cells for columns that don't apply to that row.
// Import: each row is routed by the `type` cell to its spec,
// validated, and (on commit) upserted. Dependency order isn't
// strictly enforced — the admin can put rows in any order — but
// errors on forward references (e.g. a Room row referencing a
// Location row LOWER in the same file) will surface as
// "Lieu 'X' introuvable". For a clean re-import, leave the order
// the export produced.

const UNIFIED_TYPE_COLUMN = 'type';

/** Column union across every spec, ordered by dependency. */
export function getUnifiedColumns(): string[] {
  const seen = new Set<string>();
  const cols: string[] = [];
  for (const type of DEPENDENCY_ORDER) {
    const spec = IMPORT_REGISTRY[type];
    if (!spec) continue;
    for (const c of spec.columns) {
      if (!seen.has(c.key)) {
        seen.add(c.key);
        cols.push(c.key);
      }
    }
  }
  return cols;
}

/**
 * Build a unified CSV containing every row of every entity for the
 * org. Empty cells for columns not used by a given row's type.
 */
export async function exportUnifiedCsv(params: {
  organizationId: string;
}): Promise<string> {
  const columns = getUnifiedColumns();
  const headers = [UNIFIED_TYPE_COLUMN, ...columns];
  const matrix: string[][] = [headers];
  const ctx = makeContext(params.organizationId);
  for (const type of DEPENDENCY_ORDER) {
    const spec = IMPORT_REGISTRY[type];
    if (!spec) continue;
    const rows = await spec.exportRows(ctx);
    for (const r of rows) {
      matrix.push([type, ...columns.map((k) => r[k] ?? '')]);
    }
  }
  return Papa.unparse(matrix);
}

/**
 * Template version of the unified CSV: a header row + one example
 * row per entity (so admins have a working starting point for each
 * type). The example values come from each column's `example` field.
 */
export function buildUnifiedTemplate(): string {
  const columns = getUnifiedColumns();
  const headers = [UNIFIED_TYPE_COLUMN, ...columns];
  const matrix: string[][] = [headers];
  for (const type of DEPENDENCY_ORDER) {
    const spec = IMPORT_REGISTRY[type];
    if (!spec) continue;
    const exampleByKey = new Map<string, string>(
      spec.columns.map((c) => [c.key, c.example ?? '']),
    );
    matrix.push([type, ...columns.map((k) => exampleByKey.get(k) ?? '')]);
  }
  return Papa.unparse(matrix);
}

/**
 * Group a unified-CSV row set by type. Rows with unknown / missing
 * `type` values become global errors so the admin sees the
 * problem before any per-row validation runs.
 */
function groupRowsByType(
  rawRows: Record<string, string>[],
): {
  byType: Record<string, Array<{ rowNumber: number; raw: Record<string, string> }>>;
  globalErrors: Array<{ rowNumber: number; raw: Record<string, string>; errors: string[] }>;
} {
  const byType: Record<string, Array<{ rowNumber: number; raw: Record<string, string> }>> = {};
  const globalErrors: Array<{
    rowNumber: number;
    raw: Record<string, string>;
    errors: string[];
  }> = [];
  rawRows.forEach((raw, i) => {
    const rowNumber = i + 2;
    const type = (raw[UNIFIED_TYPE_COLUMN] ?? '').trim();
    if (type.length === 0) {
      globalErrors.push({
        rowNumber,
        raw,
        errors: [`Colonne "${UNIFIED_TYPE_COLUMN}" vide — précisez l’entité.`],
      });
      return;
    }
    if (!IMPORT_REGISTRY[type]) {
      globalErrors.push({
        rowNumber,
        raw,
        errors: [
          `Type "${type}" inconnu. Valeurs valides : ${DEPENDENCY_ORDER.join(', ')}.`,
        ],
      });
      return;
    }
    if (!byType[type]) byType[type] = [];
    byType[type].push({ rowNumber, raw });
  });
  return { byType, globalErrors };
}

export type UnifiedPreviewResult = {
  totalRows: number;
  validRows: number;
  errorRows: number;
  perType: Record<string, ImportPreviewResult>;
  rowErrors: ParsedRow[];
  globalError?: string;
};

export async function previewUnifiedCsv(params: {
  organizationId: string;
  csvText: string;
}): Promise<UnifiedPreviewResult> {
  const parsed = parseCsv(params.csvText);
  if (parsed.error) {
    return {
      totalRows: 0,
      validRows: 0,
      errorRows: 0,
      perType: {},
      rowErrors: [],
      globalError: parsed.error,
    };
  }
  const parsedRows = parsed.rows!;
  const { byType, globalErrors } = groupRowsByType(parsedRows);

  const ctx = makeContext(params.organizationId);
  const perType: Record<string, ImportPreviewResult> = {};
  const rowErrors: ParsedRow[] = [...globalErrors];
  let validRows = 0;
  let errorRows = globalErrors.length;

  for (const type of DEPENDENCY_ORDER) {
    const rows = byType[type];
    if (!rows || rows.length === 0) continue;
    const spec = IMPORT_REGISTRY[type]!;
    let typeValid = 0;
    let typeError = 0;
    const typeRows: ParsedRow[] = [];
    for (const { rowNumber, raw } of rows) {
      const result = await spec.parseRow(raw, ctx);
      if (result.errors && result.errors.length > 0) {
        typeError++;
        errorRows++;
        rowErrors.push({ rowNumber, raw, errors: result.errors });
        if (typeRows.length < PREVIEW_ROW_CAP) {
          typeRows.push({ rowNumber, raw, errors: result.errors });
        }
      } else {
        typeValid++;
        validRows++;
        if (typeRows.length < PREVIEW_ROW_CAP) {
          typeRows.push({ rowNumber, raw, data: result.data, errors: [] });
        }
      }
    }
    perType[type] = {
      entityType: type,
      totalRows: rows.length,
      validRows: typeValid,
      errorRows: typeError,
      rows: typeRows,
    };
  }

  return {
    totalRows: parsedRows.length,
    validRows,
    errorRows,
    perType,
    rowErrors,
  };
}

export type UnifiedCommitResult = {
  totalRows: number;
  created: number;
  updated: number;
  skipped: number;
  errored: number;
  perType: Record<string, ImportCommitResult>;
  rowErrors: ParsedRow[];
  globalError?: string;
};

export async function commitUnifiedCsv(params: {
  organizationId: string;
  csvText: string;
}): Promise<UnifiedCommitResult> {
  const parsed = parseCsv(params.csvText);
  if (parsed.error) {
    return {
      totalRows: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      errored: 0,
      perType: {},
      rowErrors: [],
      globalError: parsed.error,
    };
  }
  const parsedRows = parsed.rows!;
  const { byType, globalErrors } = groupRowsByType(parsedRows);
  const ctx = makeContext(params.organizationId);
  const perType: Record<string, ImportCommitResult> = {};
  const rowErrors: ParsedRow[] = [...globalErrors];
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let errored = globalErrors.length;

  for (const type of DEPENDENCY_ORDER) {
    const rows = byType[type];
    if (!rows || rows.length === 0) continue;
    const spec = IMPORT_REGISTRY[type]!;
    let typeCreated = 0;
    let typeUpdated = 0;
    let typeSkipped = 0;
    let typeErrored = 0;
    const typeErrors: ParsedRow[] = [];
    for (const { rowNumber, raw } of rows) {
      const result = await spec.parseRow(raw, ctx);
      if (result.errors && result.errors.length > 0) {
        typeErrored++;
        errored++;
        const err = { rowNumber, raw, errors: result.errors };
        typeErrors.push(err);
        rowErrors.push(err);
        continue;
      }
      try {
        const upserted = await spec.upsert(result.data!, ctx);
        if (upserted.action === 'created') {
          typeCreated++;
          created++;
        } else if (upserted.action === 'updated') {
          typeUpdated++;
          updated++;
        } else {
          typeSkipped++;
          skipped++;
        }
      } catch (err) {
        typeErrored++;
        errored++;
        const e = {
          rowNumber,
          raw,
          errors: [
            `Erreur d’enregistrement : ${
              err instanceof Error ? err.message : String(err)
            }`,
          ],
        };
        typeErrors.push(e);
        rowErrors.push(e);
      }
    }
    perType[type] = {
      entityType: type,
      totalRows: rows.length,
      created: typeCreated,
      updated: typeUpdated,
      skipped: typeSkipped,
      errored: typeErrored,
      errors: typeErrors,
    };
  }

  return {
    totalRows: parsedRows.length,
    created,
    updated,
    skipped,
    errored,
    perType,
    rowErrors,
  };
}

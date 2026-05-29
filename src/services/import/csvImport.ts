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

function parseCsv(csvText: string): ParseCsvResult {
  const trimmed = csvText.replace(/^﻿/, ''); // strip UTF-8 BOM
  const parsed = Papa.parse<Record<string, string>>(trimmed, {
    header: true,
    skipEmptyLines: 'greedy',
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

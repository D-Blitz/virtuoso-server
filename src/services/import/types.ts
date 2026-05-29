// Shared types for the CSV bulk-import feature.
//
// The import system is built around an `ImportEntitySpec` per entity
// type: a declarative description of which columns the CSV should have,
// how to validate + transform each row, and how to upsert it.
//
// One spec per importable entity lives under specs/<entity>.ts. The
// orchestrator (csvImport.ts) walks the registry, calls the spec's
// hooks, and aggregates results.
//
// Why a registry + declarative specs (vs. one function per entity)?
//   - Lets the admin UI render itself dynamically by fetching the
//     column list — no need to hand-code one form per entity.
//   - Makes the CSV template downloadable per entity from a single
//     endpoint that walks the same column metadata.
//   - Adding a new entity is one file + one registry entry; the rest
//     of the pipeline is unchanged.

// Prisma client type — we accept the extended client (with soft-delete
// + archive extensions applied) so specs can call it through directly.
// Using `any` here keeps the spec hooks decoupled from the prisma
// extension shape, which is internal to ../prisma.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PrismaClient = any;

export type ImportColumnType =
  | 'string'
  | 'number' // float
  | 'integer'
  | 'boolean'
  | 'date' // ISO 8601 — yyyy-mm-dd or full ISO
  | 'enum'
  | 'array' // comma-separated values in the CSV cell
  | 'reference'; // looks up another entity by a natural key

export type ImportColumn = {
  /** Field key on the Prisma model (matches the CSV header). */
  key: string;
  /** Human label shown in the admin UI + the CSV template header row. */
  label: string;
  required: boolean;
  type: ImportColumnType;
  /** When type === 'enum'. */
  enumValues?: string[];
  /**
   * When type === 'reference': name of another importable entity
   * (e.g. 'location'). The cell value is matched against that entity's
   * `referenceColumn` (typically `name`) to resolve to an id.
   */
  referenceEntity?: string;
  referenceColumn?: string;
  /** Applied when the cell is empty + the column is optional. */
  defaultValue?: unknown;
  /** Shown in the admin UI + the CSV template as a comment hint. */
  description?: string;
  /** Example value for the CSV template. */
  example?: string;
};

/**
 * Per-row processing context — shared across parseRow + upsert so
 * specs can resolve reference columns without re-querying.
 */
export type ImportContext = {
  prisma: PrismaClient;
  organizationId: string;
  /**
   * Cache of resolved reference lookups, keyed by
   * `${entityType}:${columnValue.toLowerCase()}` → entity id.
   * Specs read + write this; the orchestrator seeds it empty per import.
   */
  referenceCache: Map<string, string | null>;
};

export type ParsedRow = {
  /** Original row number in the CSV (1-based, excluding header). */
  rowNumber: number;
  /** Raw cells before parsing — useful for echoing back on errors. */
  raw: Record<string, string>;
  /** Successfully parsed payload ready for the spec's upsert. */
  data?: Record<string, unknown>;
  errors: string[];
};

export type ImportEntitySpec = {
  type: string;
  label: string;
  description: string;
  /**
   * Column the orchestrator uses as the natural key for upserting.
   * Typically 'email' for people, 'name' for places/things.
   */
  uniqueBy: string;
  columns: ImportColumn[];

  /**
   * Validate + transform one CSV row into a Prisma-ready payload.
   * MUST return either `{ data }` (validation passed) or `{ errors }`
   * (validation failed). The orchestrator collects errors across all
   * rows before deciding to commit or not.
   */
  parseRow: (
    row: Record<string, string>,
    ctx: ImportContext,
  ) => Promise<{ data?: Record<string, unknown>; errors?: string[] }>;

  /**
   * Upsert one parsed row. Returns the resulting id + whether it
   * was created or updated. Specs that need to skip rows under
   * specific conditions (e.g. soft-deleted match) return 'skipped'.
   */
  upsert: (
    data: Record<string, unknown>,
    ctx: ImportContext,
  ) => Promise<{ id: string; action: 'created' | 'updated' | 'skipped' }>;

  /**
   * Read all rows of this entity for the org, projected into the
   * same column shape the import expects — so an export → re-import
   * round-trip is lossless (modulo M2M relations which v1 doesn't
   * handle). Each returned record's keys match the spec's columns[].
   */
  exportRows: (
    ctx: ImportContext,
  ) => Promise<Array<Record<string, string>>>;
};

export type ImportPreviewResult = {
  entityType: string;
  totalRows: number;
  validRows: number;
  errorRows: number;
  /** Per-row summary — only the first ~100 returned to keep payloads small. */
  rows: ParsedRow[];
  /** Aggregate parse error if the CSV itself is malformed (not per-row). */
  globalError?: string;
};

export type ImportCommitResult = {
  entityType: string;
  totalRows: number;
  created: number;
  updated: number;
  skipped: number;
  errored: number;
  /** Per-row error details — same shape as preview. */
  errors: ParsedRow[];
};

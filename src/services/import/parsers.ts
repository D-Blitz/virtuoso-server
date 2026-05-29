// Small parse helpers used by every entity spec to coerce a raw CSV
// cell (always a string after parsing) into the right shape +
// surface friendly error messages.
//
// Each helper returns `{ value }` on success or `{ error }` on
// failure. Specs collect errors into a single array per row.

export type ParseResult<T> = { value?: T; error?: string };

export function parseString(
  cell: string | undefined,
  opts: { required?: boolean; label?: string } = {},
): ParseResult<string | null> {
  const v = (cell ?? '').trim();
  if (v.length === 0) {
    if (opts.required) {
      return { error: `${opts.label ?? 'champ'} est requis` };
    }
    return { value: null };
  }
  return { value: v };
}

export function parseInteger(
  cell: string | undefined,
  opts: { required?: boolean; label?: string; min?: number; max?: number } = {},
): ParseResult<number | null> {
  const v = (cell ?? '').trim();
  if (v.length === 0) {
    if (opts.required) return { error: `${opts.label ?? 'champ'} est requis` };
    return { value: null };
  }
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { error: `${opts.label ?? 'champ'} doit être un nombre entier (reçu : "${v}")` };
  }
  if (opts.min !== undefined && n < opts.min) {
    return { error: `${opts.label ?? 'champ'} doit être >= ${opts.min}` };
  }
  if (opts.max !== undefined && n > opts.max) {
    return { error: `${opts.label ?? 'champ'} doit être <= ${opts.max}` };
  }
  return { value: n };
}

export function parseFloatNumber(
  cell: string | undefined,
  opts: { required?: boolean; label?: string; min?: number; max?: number } = {},
): ParseResult<number | null> {
  const v = (cell ?? '').trim().replace(',', '.'); // accept fr decimals
  if (v.length === 0) {
    if (opts.required) return { error: `${opts.label ?? 'champ'} est requis` };
    return { value: null };
  }
  const n = Number(v);
  if (!Number.isFinite(n)) {
    return { error: `${opts.label ?? 'champ'} doit être un nombre (reçu : "${v}")` };
  }
  if (opts.min !== undefined && n < opts.min) {
    return { error: `${opts.label ?? 'champ'} doit être >= ${opts.min}` };
  }
  if (opts.max !== undefined && n > opts.max) {
    return { error: `${opts.label ?? 'champ'} doit être <= ${opts.max}` };
  }
  return { value: n };
}

const TRUTHY = new Set(['true', '1', 'yes', 'oui', 'y', 'o', 'vrai']);
const FALSY = new Set(['false', '0', 'no', 'non', 'n', 'faux', '']);

export function parseBoolean(
  cell: string | undefined,
  opts: { required?: boolean; label?: string; default?: boolean } = {},
): ParseResult<boolean | null> {
  const v = (cell ?? '').trim().toLowerCase();
  if (v.length === 0) {
    if (opts.required) return { error: `${opts.label ?? 'champ'} est requis` };
    return { value: opts.default ?? null };
  }
  if (TRUTHY.has(v)) return { value: true };
  if (FALSY.has(v)) return { value: false };
  return {
    error: `${opts.label ?? 'champ'} doit être oui/non, true/false ou 1/0 (reçu : "${v}")`,
  };
}

export function parseDate(
  cell: string | undefined,
  opts: { required?: boolean; label?: string } = {},
): ParseResult<Date | null> {
  const v = (cell ?? '').trim();
  if (v.length === 0) {
    if (opts.required) return { error: `${opts.label ?? 'champ'} est requis` };
    return { value: null };
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    return {
      error: `${opts.label ?? 'champ'} doit être une date ISO yyyy-mm-dd (reçu : "${v}")`,
    };
  }
  return { value: d };
}

export function parseEnum<T extends string>(
  cell: string | undefined,
  values: readonly T[],
  opts: { required?: boolean; label?: string; default?: T } = {},
): ParseResult<T | null> {
  const v = (cell ?? '').trim().toUpperCase();
  if (v.length === 0) {
    if (opts.required) return { error: `${opts.label ?? 'champ'} est requis` };
    return { value: opts.default ?? null };
  }
  const match = values.find((x) => x.toUpperCase() === v);
  if (!match) {
    return {
      error: `${opts.label ?? 'champ'} doit être l’une de ${values.join(' / ')} (reçu : "${cell}")`,
    };
  }
  return { value: match };
}

export function parseArray(
  cell: string | undefined,
  opts: { required?: boolean; label?: string; separator?: string } = {},
): ParseResult<string[] | null> {
  const v = (cell ?? '').trim();
  if (v.length === 0) {
    if (opts.required) return { error: `${opts.label ?? 'champ'} est requis` };
    return { value: [] };
  }
  const sep = opts.separator ?? ',';
  return {
    value: v
      .split(sep)
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Wraps parseString with an email shape check. Used by Facilitator
 * + Client where email is required + the natural upsert key.
 */
export function parseEmail(
  cell: string | undefined,
  opts: { required?: boolean; label?: string } = {},
): ParseResult<string | null> {
  const r = parseString(cell, opts);
  if (r.error) return r;
  if (r.value == null) return r;
  if (!EMAIL_RE.test(r.value)) {
    return { error: `${opts.label ?? 'email'} n’est pas une adresse valide` };
  }
  return r;
}

export function parseHexColor(
  cell: string | undefined,
  opts: { required?: boolean; label?: string; default?: string } = {},
): ParseResult<string | null> {
  const v = (cell ?? '').trim();
  if (v.length === 0) {
    if (opts.required) return { error: `${opts.label ?? 'champ'} est requis` };
    return { value: opts.default ?? null };
  }
  if (!HEX_COLOR_RE.test(v)) {
    return {
      error: `${opts.label ?? 'champ'} doit être une couleur hex (#abc ou #aabbcc, reçu : "${v}")`,
    };
  }
  return { value: v };
}

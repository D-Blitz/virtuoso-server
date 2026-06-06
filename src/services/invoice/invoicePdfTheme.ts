/**
 * Phase E — per-issuer invoice PDF theme.
 *
 * Each BillingIdentity (the school and every freelance teacher) may carry
 * its own visual theme for the PDF it issues, stored as a flexible JSON
 * blob on `BillingIdentity.pdfTheme` (null = the house default below). The
 * blob is intentionally schemaless at the DB level so the theme can grow
 * new knobs without a migration each time; this module is the single place
 * that gives that blob a typed shape, sane defaults, and defensive parsing.
 *
 * All colors are CSS color strings; sizes are numbers in the unit named by
 * the key (…Px / …Pt). The template (invoicePdfTemplate.ts) is the only
 * consumer — it reads a fully-resolved theme (never the raw blob), so every
 * field is guaranteed present and well-typed by `resolvePdfTheme`.
 */

export type InvoicePdfTheme = {
  /** Accent used for the invoice title, totals box and table header fill. */
  accentColor: string;
  /** Text color printed ON the accent (e.g. the table header row). */
  accentTextColor: string;
  /** Primary body text. */
  textColor: string;
  /** Secondary / label text (dates, captions, addresses). */
  mutedColor: string;
  /** Hairline color for table rules and boxes. */
  borderColor: string;
  /** Page background (kept white for print by default). */
  pageBackground: string;
  /** CSS font stack for the whole document. */
  fontFamily: string;
  /** Base font size, in points. */
  fontSizePt: number;
  /** Upper bound for the issuer logo height, in pixels. */
  logoMaxHeightPx: number;
  /** Print the IBAN / BIC "règlement par virement" block. */
  showBankDetails: boolean;
  /** Print the issuer's free-text legal mentions block. */
  showLegalMentions: boolean;
  /** Optional line shown under the issuer identity (e.g. a tagline). */
  headerNote: string | null;
  /** Optional centered note printed in the page footer. */
  footerNote: string | null;
};

export const DEFAULT_PDF_THEME: InvoicePdfTheme = {
  accentColor: '#1f6feb',
  accentTextColor: '#ffffff',
  textColor: '#1a1a1a',
  mutedColor: '#6b7280',
  borderColor: '#e2e5e9',
  pageBackground: '#ffffff',
  fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  fontSizePt: 10,
  logoMaxHeightPx: 64,
  showBankDetails: true,
  showLegalMentions: true,
  headerNote: null,
  footerNote: null,
};

/** The knobs a client/editor is allowed to set, with their value types. */
export type InvoicePdfThemeInput = Partial<InvoicePdfTheme>;

const COLOR_KEYS = [
  'accentColor',
  'accentTextColor',
  'textColor',
  'mutedColor',
  'borderColor',
  'pageBackground',
] as const;

const BOOLEAN_KEYS = ['showBankDetails', 'showLegalMentions'] as const;
const NOTE_KEYS = ['headerNote', 'footerNote'] as const;

/**
 * A permissive CSS-color sanity check: hex (#rgb / #rrggbb / #rrggbbaa),
 * rgb()/rgba()/hsl()/hsla(), or a bare CSS keyword (letters only). Anything
 * else is rejected and falls back to the default — the value goes into a
 * <style> we control, but this still blocks "</style>"-style breakouts.
 */
function isSafeColor(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (!s || s.length > 64) return false;
  return (
    /^#[0-9a-fA-F]{3,8}$/.test(s) ||
    /^(rgb|rgba|hsl|hsla)\([0-9.,%\s/]+\)$/.test(s) ||
    /^[a-zA-Z]+$/.test(s)
  );
}

/** Clamp a finite number into [min, max]; non-numbers return the fallback. */
function clampNumber(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** A font stack is accepted if it is a short string free of CSS delimiters. */
function safeFontFamily(v: unknown): string {
  if (typeof v !== 'string') return DEFAULT_PDF_THEME.fontFamily;
  const s = v.trim();
  if (!s || s.length > 200) return DEFAULT_PDF_THEME.fontFamily;
  if (/[<>{};]/.test(s)) return DEFAULT_PDF_THEME.fontFamily;
  return s;
}

/** Trim a free-text note; empty collapses to null; hard length cap. */
function safeNote(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > 500 ? s.slice(0, 500) : s;
}

/**
 * Merge a raw stored blob (or partial editor input) onto the house default,
 * validating every field. Unknown keys are dropped; invalid values fall back
 * to the default. Always returns a complete, render-ready theme.
 */
export function resolvePdfTheme(raw: unknown): InvoicePdfTheme {
  const theme: InvoicePdfTheme = { ...DEFAULT_PDF_THEME };
  if (!raw || typeof raw !== 'object') return theme;
  const src = raw as Record<string, unknown>;

  for (const key of COLOR_KEYS) {
    if (isSafeColor(src[key])) theme[key] = (src[key] as string).trim();
  }
  for (const key of BOOLEAN_KEYS) {
    if (typeof src[key] === 'boolean') theme[key] = src[key] as boolean;
  }
  for (const key of NOTE_KEYS) {
    if (key in src) theme[key] = safeNote(src[key]);
  }
  if ('fontFamily' in src) theme.fontFamily = safeFontFamily(src.fontFamily);
  if ('fontSizePt' in src) {
    theme.fontSizePt = clampNumber(src.fontSizePt, 7, 16, DEFAULT_PDF_THEME.fontSizePt);
  }
  if ('logoMaxHeightPx' in src) {
    theme.logoMaxHeightPx = clampNumber(
      src.logoMaxHeightPx,
      16,
      200,
      DEFAULT_PDF_THEME.logoMaxHeightPx,
    );
  }
  return theme;
}

/**
 * Normalize editor input into a clean blob to PERSIST. Returns only the
 * recognised, validated keys (so we never store junk), or `null` when the
 * caller explicitly clears the theme. A normalized-to-default field is kept
 * verbatim — storing it is harmless and makes the editor round-trip exact.
 */
export function normalizePdfThemeForStorage(
  raw: unknown,
): InvoicePdfTheme | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object') return null;
  // resolvePdfTheme already validates + clamps every field; persisting the
  // resolved theme guarantees what we store is exactly what we'll render.
  return resolvePdfTheme(raw);
}

/**
 * Quote-engine smoke test.
 *
 * Pure-logic regression guard for EnrollmentQuoteService — no DB, no
 * HTTP, runs in milliseconds. Locks the June 2026 pricing fix:
 *
 *   Service.defaultPrice is the price for ONE occurrence (per séance),
 *   NOT a period total to be divided by the lesson count.
 *
 * The old formula was `perOccurrence = basePrice / totalInTerm`, which
 * a stale ts-node dev server kept serving for days (ts-node has no
 * hot-reload). There was no test on this engine, so the regression was
 * invisible. This guard asserts the relationships — not brittle
 * absolute counts — so it survives calendar drift.
 *
 * Usage: npx ts-node scripts/quoteSmokeTest.ts
 */
import { EnrollmentQuoteService } from '../src/services/enrollment/enrollmentQuote.service';

let assertionCount = 0;
let failureCount = 0;

function assert(cond: unknown, label: string): void {
  assertionCount += 1;
  if (!cond) {
    failureCount += 1;
    console.error(`  ❌  ${label}`);
  } else {
    console.log(`  ✅  ${label}`);
  }
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  assert(actual === expected, `${label} (got ${String(actual)}, want ${String(expected)})`);
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

const svc = new EnrollmentQuoteService();

// A ~12-week term, weekly on Mondays. Jan 5 2026 is a Monday.
const term = {
  id: 'term-1',
  name: 'Test période',
  startDate: new Date('2026-01-05T00:00:00Z'),
  endDate: new Date('2026-03-30T00:00:00Z'),
};

// defaultPrice mirrors the bug report screenshot: 36.98 € per séance.
const service = {
  id: 'svc-1',
  name: 'Piano',
  defaultPrice: 36.98,
  defaultDurationMinutes: 45,
};

const weekly = {
  service,
  term,
  startTime: '10:00',
  durationMinutes: 45,
  frequency: 'WEEKLY' as const,
  weekday: 1, // Monday
};

console.log('\nQuote engine smoke — pricing relationships\n');

// 1) THE fix: per-occurrence price is the catalog price, undivided.
{
  const q = svc.quote({ ...weekly, startDate: term.startDate, pricingStrategy: 'PERIOD_PRORATED' });
  assertEq(q.price.basePrice, 36.98, 'basePrice === service.defaultPrice');
  assertEq(q.price.perOccurrence, 36.98, 'perOccurrence === service.defaultPrice (NOT basePrice / N)');
  assert(
    q.lessons.totalInTerm >= 10 && q.lessons.totalInTerm <= 14,
    `weekly 12-week term yields ~13 lessons (got ${q.lessons.totalInTerm})`,
  );
  assertEq(
    q.price.total,
    round2(36.98 * q.lessons.remaining),
    'PRORATED total === perOccurrence × remaining',
  );
}

// 2) Strategy semantics on a MID-TERM join (remaining < totalInTerm).
{
  const mid = new Date('2026-02-16T00:00:00Z'); // a Monday, ~6 weeks in
  const fixed = svc.quote({ ...weekly, startDate: mid, pricingStrategy: 'PERIOD_FIXED' });
  const perOcc = svc.quote({ ...weekly, startDate: mid, pricingStrategy: 'PER_OCCURRENCE' });
  const prorated = svc.quote({ ...weekly, startDate: mid, pricingStrategy: 'PERIOD_PRORATED' });

  assert(
    fixed.lessons.remaining < fixed.lessons.totalInTerm,
    'mid-term join: remaining < totalInTerm',
  );
  assertEq(
    fixed.price.total,
    round2(fixed.price.perOccurrence * fixed.lessons.totalInTerm),
    'FIXED total === perOccurrence × totalInTerm (whole period, regardless of join date)',
  );
  assertEq(
    perOcc.price.total,
    round2(perOcc.price.perOccurrence * perOcc.lessons.remaining),
    'PER_OCCURRENCE total === perOccurrence × remaining',
  );
  assertEq(
    prorated.price.total,
    perOcc.price.total,
    'PRORATED total === PER_OCCURRENCE total (same up-front math)',
  );
  assert(
    fixed.price.total > perOcc.price.total,
    'FIXED costs more than PER_OCCURRENCE for a mid-term join',
  );
}

// 3) CUSTOM dates: lessons = explicit dates that fall inside the term.
{
  const customDates = [
    '2026-01-10T10:00:00Z',
    '2026-02-10T10:00:00Z',
    '2026-03-10T10:00:00Z',
    '2025-12-01T10:00:00Z', // before term.startDate — must be excluded
  ];
  const q = svc.quote({
    service,
    term,
    startDate: term.startDate,
    frequency: 'CUSTOM',
    weekday: null,
    startTime: '10:00',
    durationMinutes: 45,
    customDates,
    pricingStrategy: 'PER_OCCURRENCE',
  });
  assertEq(q.lessons.totalInTerm, 3, 'CUSTOM: only in-window dates count (out-of-window dropped)');
  assertEq(
    q.price.total,
    round2(36.98 * q.lessons.remaining),
    'CUSTOM total === perOccurrence × remaining',
  );
}

// 4) Active-window endDate bounds "remaining" (June 2026 fix). An
//    enrollment can END before the term — shortening "Dernière
//    occurrence" must shrink the billed lessons + total. totalInTerm
//    (the proration denominator) stays the FULL term.
{
  const full = svc.quote({
    ...weekly,
    startDate: term.startDate,
    pricingStrategy: 'PERIOD_PRORATED',
  });
  // End the window on Feb 16 (a Monday, ~6 weeks in): Jan 5 → Feb 16
  // inclusive = 7 Mondays.
  const bounded = svc.quote({
    ...weekly,
    startDate: term.startDate,
    endDate: new Date('2026-02-16T00:00:00Z'),
    pricingStrategy: 'PERIOD_PRORATED',
  });
  assert(
    bounded.lessons.remaining < full.lessons.remaining,
    `endDate shrinks remaining (${bounded.lessons.remaining} < ${full.lessons.remaining})`,
  );
  assertEq(
    bounded.lessons.remaining,
    7,
    'endDate is INCLUSIVE — the Feb 16 occurrence still counts',
  );
  assertEq(
    bounded.lessons.totalInTerm,
    full.lessons.totalInTerm,
    'totalInTerm stays the full term (proration denominator unchanged)',
  );
  assertEq(
    bounded.price.total,
    round2(36.98 * bounded.lessons.remaining),
    'bounded PRORATED total === perOccurrence × bounded remaining',
  );
  // endDate AFTER the term end is clamped — it never extends past it.
  const overshoot = svc.quote({
    ...weekly,
    startDate: term.startDate,
    endDate: new Date('2026-05-30T00:00:00Z'),
    pricingStrategy: 'PERIOD_PRORATED',
  });
  assertEq(
    overshoot.lessons.remaining,
    full.lessons.remaining,
    'endDate past term end is clamped to the term (no extra lessons)',
  );
}

console.log(`\n${assertionCount} assertions, ${failureCount} failures\n`);
process.exit(failureCount === 0 ? 0 : 1);

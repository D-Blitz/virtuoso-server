/**
 * Recurrence rule + occurrence generator.
 *
 * Pure functions, no DB. See docs/RECURRENCE_DESIGN.md for the design.
 *
 * Frequencies are a closed set — no full RRULE. Each frequency has a
 * fixed period; there is no separate `interval` field.
 */

export const FREQUENCIES = [
  'WEEKLY',
  'BIWEEKLY',
  'MONTHLY',
  'BIMONTHLY',
  'TRIMESTRAL',
  'SEMIANNUAL',
  'YEARLY',
] as const;

export type Frequency = (typeof FREQUENCIES)[number];

export function isFrequency(value: unknown): value is Frequency {
  return (
    typeof value === 'string' &&
    (FREQUENCIES as readonly string[]).includes(value)
  );
}

/**
 * Hard cap to refuse pathological inputs (e.g. weekly until year 9999).
 * A music school's real series tops out around 260 occurrences
 * (weekly × 5 years), so 500 is a comfortable ceiling.
 */
export const MAX_OCCURRENCES = 500;

export type RecurrenceInput = {
  frequency: Frequency;
  /** Start of the first occurrence (datetime; time-of-day preserved across steps). */
  startDate: Date;
  /** Inclusive last possible occurrence boundary. */
  endDate: Date;
  /** Duration in ms — same for every materialized occurrence. */
  durationMs: number;
};

export type Occurrence = {
  startTime: Date;
  endTime: Date;
};

/**
 * Add one period of the given frequency to `date`, preserving time of day.
 * For month-based frequencies, clamps to the last day of the target month
 * when the source day doesn't exist (Jan 31 + 1 month → Feb 28/29).
 */
export function stepOnce(date: Date, frequency: Frequency): Date {
  const d = new Date(date.getTime());
  switch (frequency) {
    case 'WEEKLY':
      d.setDate(d.getDate() + 7);
      return d;
    case 'BIWEEKLY':
      d.setDate(d.getDate() + 14);
      return d;
    case 'MONTHLY':
      return addMonthsClamped(d, 1);
    case 'BIMONTHLY':
      return addMonthsClamped(d, 2);
    case 'TRIMESTRAL':
      return addMonthsClamped(d, 3);
    case 'SEMIANNUAL':
      return addMonthsClamped(d, 6);
    case 'YEARLY':
      return addMonthsClamped(d, 12);
  }
}

/**
 * Add `n` months while clamping the day-of-month to the target month's
 * last day if the source day exceeds it.
 *
 * Inlined here rather than pulling date-fns just for this — the server
 * doesn't already import date-fns and we want the recurrence module to
 * stay dependency-free.
 */
function addMonthsClamped(d: Date, n: number): Date {
  const year = d.getFullYear();
  const month = d.getMonth() + n;
  const day = d.getDate();
  // Last day of the target month: day 0 of (target+1).
  const targetLastDay = new Date(year, month + 1, 0).getDate();
  const clampedDay = Math.min(day, targetLastDay);
  return new Date(
    year,
    month,
    clampedDay,
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
    d.getMilliseconds(),
  );
}

/**
 * Walk the rule from `startDate` until `current > endDate`, yielding one
 * occurrence per step.
 *
 * Throws if the rule would produce more than `MAX_OCCURRENCES`.
 * Throws if `startDate >= endDate` or `durationMs <= 0`.
 */
export function generateOccurrences(input: RecurrenceInput): Occurrence[] {
  const { frequency, startDate, endDate, durationMs } = input;
  if (!isFrequency(frequency)) {
    throw new Error(`Unknown frequency: ${frequency}`);
  }
  if (durationMs <= 0) {
    throw new Error('durationMs must be positive');
  }
  if (startDate.getTime() > endDate.getTime()) {
    throw new Error('startDate must be on or before endDate');
  }

  const occurrences: Occurrence[] = [];
  let cursor = new Date(startDate.getTime());

  while (cursor.getTime() <= endDate.getTime()) {
    occurrences.push({
      startTime: new Date(cursor.getTime()),
      endTime: new Date(cursor.getTime() + durationMs),
    });
    if (occurrences.length >= MAX_OCCURRENCES) {
      throw new Error(
        `Series exceeds ${MAX_OCCURRENCES}-occurrence cap (got ${occurrences.length}); shorten endDate or pick a less frequent rule.`,
      );
    }
    cursor = stepOnce(cursor, frequency);
  }

  return occurrences;
}

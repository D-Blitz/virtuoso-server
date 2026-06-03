// Enrollment recurrence dispatcher.
//
// Phase A (May 2026): Enrollment only supported weekly recurrence.
// Phase B (June 2026): added BIWEEKLY, MONTHLY, DAILY, and CUSTOM
// (admin-supplied list of explicit dates).
//
// The legacy `generateWeeklyOccurrences` is still used by the
// EventForm path (one-off events with optional recurrence) and the
// existing quote service for the widget flow — we don't refactor
// those callers in this pass. New callers (Enrollment generator +
// quote rewrite) should use `generateEnrollmentOccurrences`.

import { generateWeeklyOccurrences } from './weeklyRecurrence.utils';

export type EnrollmentFrequency =
  | 'WEEKLY'
  | 'BIWEEKLY'
  | 'MONTHLY'
  | 'DAILY'
  | 'CUSTOM';

export type EnrollmentOccurrence = {
  startTime: Date;
  endTime: Date;
};

export type EnrollmentRecurrenceInput = {
  frequency: EnrollmentFrequency;
  /**
   * Active window — bounds EVERY frequency, including CUSTOM. Dates
   * outside [startDate, endDate] (treated as inclusive calendar days)
   * are dropped.
   */
  startDate: Date;
  endDate: Date;
  /** Required for WEEKLY / BIWEEKLY / MONTHLY. */
  weekday?: number | null;
  /** "HH:MM" 24h — applied to each occurrence's calendar date. */
  startTime: string;
  durationMinutes: number;
  /**
   * Required for CUSTOM. Each entry is the exact start datetime of
   * one occurrence. Stored as ISO strings on Enrollment.customDates;
   * pass them through as-is (`new Date(str)`).
   */
  customDates?: string[] | null;
};

const addDays = (d: Date, n: number): Date => {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + n);
  return copy;
};

const setTimeFromHHmm = (date: Date, hhmm: string): Date => {
  const [h, m] = hhmm.split(':').map((x) => Number(x));
  const copy = new Date(date);
  copy.setHours(h, m, 0, 0);
  return copy;
};

/**
 * Skip `stepWeeks` weeks at a time starting from the first hit of
 * `weekday` on or after `startDate`. Used for WEEKLY (step=1) and
 * BIWEEKLY (step=2).
 */
const generateStepWeekly = (
  startDate: Date,
  endDate: Date,
  weekday: number,
  startTimeHHmm: string,
  durationMinutes: number,
  stepWeeks: number,
): EnrollmentOccurrence[] => {
  const occurrences: EnrollmentOccurrence[] = [];
  const diff = (weekday - startDate.getDay() + 7) % 7;
  let cursor = addDays(startDate, diff);
  while (cursor <= endDate) {
    const start = setTimeFromHHmm(cursor, startTimeHHmm);
    const end = new Date(start.getTime() + durationMinutes * 60_000);
    occurrences.push({ startTime: start, endTime: end });
    cursor = addDays(cursor, 7 * stepWeeks);
  }
  return occurrences;
};

/**
 * Approximation: monthly = every 4 weeks anchored on the picked
 * weekday. The "Nth weekday of month" semantics (e.g. 2nd Tuesday)
 * is a richer feature deferred until the calendar form needs it
 * too — for now MONTHLY admins get ~12 occurrences per year on the
 * same weekday, which matches how schools usually mean it.
 */
const generateMonthlyApprox = (
  startDate: Date,
  endDate: Date,
  weekday: number,
  startTimeHHmm: string,
  durationMinutes: number,
): EnrollmentOccurrence[] => {
  return generateStepWeekly(
    startDate,
    endDate,
    weekday,
    startTimeHHmm,
    durationMinutes,
    4,
  );
};

const generateDaily = (
  startDate: Date,
  endDate: Date,
  startTimeHHmm: string,
  durationMinutes: number,
): EnrollmentOccurrence[] => {
  const occurrences: EnrollmentOccurrence[] = [];
  let cursor = new Date(startDate);
  while (cursor <= endDate) {
    const start = setTimeFromHHmm(cursor, startTimeHHmm);
    const end = new Date(start.getTime() + durationMinutes * 60_000);
    occurrences.push({ startTime: start, endTime: end });
    cursor = addDays(cursor, 1);
  }
  return occurrences;
};

const startOfDay = (d: Date): Date => {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
};

const endOfDay = (d: Date): Date => {
  const copy = new Date(d);
  copy.setHours(23, 59, 59, 999);
  return copy;
};

const generateCustom = (
  customDates: string[],
  startDate: Date,
  endDate: Date,
  durationMinutes: number,
): EnrollmentOccurrence[] => {
  // CUSTOM dates are bounded by the active window, exactly like every
  // other frequency. Without this, the quote service — which calls the
  // generator twice with DIFFERENT windows to derive "total in term"
  // vs "remaining" — would get identical lists, and event generation
  // would materialize dates outside the enrollment's own start/end.
  // The window is treated as inclusive calendar days.
  const windowStart = startOfDay(startDate);
  const windowEnd = endOfDay(endDate);
  return customDates
    .map((iso) => {
      const start = new Date(iso);
      if (Number.isNaN(start.getTime())) return null;
      return {
        startTime: start,
        endTime: new Date(start.getTime() + durationMinutes * 60_000),
      };
    })
    .filter((o): o is EnrollmentOccurrence => o !== null)
    .filter((o) => o.startTime >= windowStart && o.startTime <= windowEnd)
    .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
};

export function generateEnrollmentOccurrences(
  input: EnrollmentRecurrenceInput,
): EnrollmentOccurrence[] {
  const {
    frequency,
    startDate,
    endDate,
    weekday,
    startTime,
    durationMinutes,
    customDates,
  } = input;

  switch (frequency) {
    case 'WEEKLY':
      if (weekday == null) return [];
      return generateWeeklyOccurrences({
        startDate,
        endDate,
        weekday,
        startTimeHHmm: startTime,
        durationMinutes,
      });
    case 'BIWEEKLY':
      if (weekday == null) return [];
      return generateStepWeekly(
        startDate,
        endDate,
        weekday,
        startTime,
        durationMinutes,
        2,
      );
    case 'MONTHLY':
      if (weekday == null) return [];
      return generateMonthlyApprox(
        startDate,
        endDate,
        weekday,
        startTime,
        durationMinutes,
      );
    case 'DAILY':
      return generateDaily(startDate, endDate, startTime, durationMinutes);
    case 'CUSTOM':
      if (!customDates || customDates.length === 0) return [];
      return generateCustom(customDates, startDate, endDate, durationMinutes);
    default:
      return [];
  }
}

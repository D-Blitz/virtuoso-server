// Enrollment quote service.
//
// Computes the per-occurrence price + the prorated total for an
// enrollment given:
//   - service (base price + default duration)
//   - term (active window for proration math)
//   - the recurrence rule the admin is editing
//
// The form fetches this on every change and displays "X € × N
// cours = Y € total". Same engine used by:
//   - admin EnrollmentForm live preview
//   - widget checkout flow (existing caller)
//
// Phase B (June 2026) — extended to dispatch on frequency. Custom-
// dates rules are also priced: lessons.total = customDates within
// the term window; lessons.remaining = customDates ≥ startDate.

import {
  generateEnrollmentOccurrences,
  type EnrollmentFrequency,
} from '../../domain/recurrence/enrollmentRecurrence.utils';

type QuoteInput = {
  service: {
    id: string;
    name: string;
    defaultPrice: number;
    defaultDurationMinutes: number;
  };
  term: {
    id: string;
    name: string;
    startDate: Date;
    endDate: Date;
  };
  startDate: Date;
  /**
   * Optional active-window end. When provided, the "remaining"
   * occurrences are bounded by min(endDate, term.endDate) — the admin
   * can end an enrollment before the term does (e.g. a student who
   * leaves mid-term). Treated as an inclusive calendar day. Omitted by
   * legacy widget callers, which bill through the term end.
   */
  endDate?: Date | null;
  /**
   * Optional. Defaults to WEEKLY for backward compatibility with
   * pre-June callers (enrollmentInvite.service.ts and friends still
   * call with just {weekday, startTime} — they're entirely
   * weekly-based flows).
   */
  frequency?: EnrollmentFrequency;
  weekday?: number | null;
  startTime: string;
  durationMinutes: number;
  customDates?: string[] | null;
  /**
   * Optional pricing strategy hint. Defaults to PERIOD_PRORATED if
   * the caller doesn't specify. The quote returns a strategy field
   * so the UI can render the right label.
   */
  pricingStrategy?: 'PERIOD_PRORATED' | 'PERIOD_FIXED' | 'PER_OCCURRENCE';
};

const endOfDay = (d: Date): Date => {
  const copy = new Date(d);
  copy.setHours(23, 59, 59, 999);
  return copy;
};

export class EnrollmentQuoteService {
  quote(input: QuoteInput) {
    const {
      service,
      term,
      startDate,
      endDate,
      frequency = 'WEEKLY',
      weekday,
      startTime,
      durationMinutes,
      customDates,
      pricingStrategy = 'PERIOD_PRORATED',
    } = input;

    // Active window: from max(startDate, term.startDate) to
    // min(endDate, term.endDate). An enrollment that "starts mid-term"
    // only bills for the lessons remaining; one that ENDS early (admin
    // shortened "Dernière occurrence") stops there. Either way the term
    // hard-bounds the window. endDate is an inclusive calendar day; when
    // omitted (legacy widget callers) the window runs to the term end.
    const windowStart = startDate < term.startDate ? term.startDate : startDate;
    const requestedEnd = endDate != null ? endOfDay(endDate) : term.endDate;
    const windowEnd =
      requestedEnd < term.endDate ? requestedEnd : term.endDate;

    const remainingOccurrences = generateEnrollmentOccurrences({
      frequency,
      startDate: windowStart,
      endDate: windowEnd,
      weekday,
      startTime,
      durationMinutes,
      customDates,
    });

    const fullTermOccurrences = generateEnrollmentOccurrences({
      frequency,
      startDate: term.startDate,
      endDate: term.endDate,
      weekday,
      startTime,
      durationMinutes,
      customDates,
    });

    // Service.defaultPrice is the price for ONE occurrence (one
    // session/lesson/event). The total billed depends on the
    // strategy:
    //   PER_OCCURRENCE  - charged per session, pay only for what's
    //                     scheduled. total = perEvent × remaining
    //   PERIOD_PRORATED - subscription prorated by lessons remaining.
    //                     total = perEvent × remaining (same math
    //                     as PER_OCCURRENCE; the conceptual
    //                     difference matters for billing cadence
    //                     and refund policy, not the up-front total)
    //   PERIOD_FIXED    - flat period bill regardless of joining
    //                     date. total = perEvent × totalInTerm
    const basePrice = service.defaultPrice; // per-occurrence base
    const totalInTerm = fullTermOccurrences.length || 1;
    const remaining = remainingOccurrences.length;

    const perOccurrence = basePrice;

    let totalBilled: number;
    switch (pricingStrategy) {
      case 'PERIOD_FIXED':
        totalBilled =
          Math.round(perOccurrence * totalInTerm * 100) / 100;
        break;
      case 'PER_OCCURRENCE':
      case 'PERIOD_PRORATED':
      default:
        totalBilled =
          Math.round(perOccurrence * remaining * 100) / 100;
        break;
    }

    return {
      term: {
        id: term.id,
        name: term.name,
        startDate: term.startDate,
        endDate: term.endDate,
      },
      service: {
        id: service.id,
        name: service.name,
        basePrice,
        defaultDurationMinutes: service.defaultDurationMinutes,
      },
      window: {
        startDate: windowStart,
        endDate: windowEnd,
        frequency,
        weekday: weekday ?? null,
        startTime,
        durationMinutes,
      },
      lessons: {
        totalInTerm,
        remaining,
      },
      price: {
        basePrice,           // Service.defaultPrice (the catalog price)
        perOccurrence,        // What ONE occurrence costs
        total: totalBilled,   // What this enrollment will actually charge
        strategy: pricingStrategy,
      },
      preview: {
        firstLesson: remainingOccurrences[0]?.startTime ?? null,
        lastLesson:
          remainingOccurrences[remainingOccurrences.length - 1]?.startTime ??
          null,
        // Cap preview to 12 entries to keep payloads small for big
        // CUSTOM-date rules.
        occurrences: remainingOccurrences.slice(0, 12),
      },
    };
  }
}

import { generateWeeklyOccurrences } from '../../domain/recurrence/weeklyRecurrence.utils';

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
  weekday: number;
  startTime: string;
  durationMinutes: number;
};

export class EnrollmentQuoteService {
  quote(input: QuoteInput) {
    const { service, term, startDate, weekday, startTime, durationMinutes } = input;

    const windowStart = startDate < term.startDate ? term.startDate : startDate;
    const windowEnd = term.endDate;

    const remainingOccurrences = generateWeeklyOccurrences({
      startDate: windowStart,
      endDate: windowEnd,
      weekday,
      startTimeHHmm: startTime,
      durationMinutes,
    });

    const fullTermOccurrences = generateWeeklyOccurrences({
      startDate: term.startDate,
      endDate: term.endDate,
      weekday,
      startTimeHHmm: startTime,
      durationMinutes,
    });

    const basePrice = service.defaultPrice;
    const totalInTerm = fullTermOccurrences.length || 1;
    const remaining = remainingOccurrences.length;

    // v1 proration by lesson count
    const prorated = Math.round(basePrice * (remaining / totalInTerm) * 100) / 100;

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
        weekday,
        startTime,
        durationMinutes,
      },
      lessons: {
        totalInTerm,
        remaining,
      },
      price: {
        basePrice,
        prorated,
        strategy: 'TERM_PRORATED_BY_LESSONS',
      },
      preview: {
        firstLesson: remainingOccurrences[0]?.startTime ?? null,
        lastLesson: remainingOccurrences[remainingOccurrences.length - 1]?.startTime ?? null,
        occurrences: remainingOccurrences.slice(0, 12), // avoid huge payload
      },
    };
  }
}

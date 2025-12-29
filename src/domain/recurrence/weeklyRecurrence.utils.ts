export type WeeklyOccurrence = {
  startTime: Date;
  endTime: Date;
};

const addDays = (d: Date, days: number) => {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + days);
  return copy;
};

const nextWeekdayOnOrAfter = (start: Date, weekday: number) => {
  const day = start.getDay();
  const diff = (weekday - day + 7) % 7;
  return addDays(start, diff);
};

const setTimeFromHHmm = (date: Date, hhmm: string) => {
  const [h, m] = hhmm.split(':').map((x) => Number(x));
  const copy = new Date(date);
  copy.setHours(h, m, 0, 0);
  return copy;
};

export const generateWeeklyOccurrences = (params: {
  startDate: Date;
  endDate: Date;
  weekday: number; // 0..6
  startTimeHHmm: string; // "17:00"
  durationMinutes: number;
}): WeeklyOccurrence[] => {
  const { startDate, endDate, weekday, startTimeHHmm, durationMinutes } = params;

  const occurrences: WeeklyOccurrence[] = [];

  let cursor = nextWeekdayOnOrAfter(startDate, weekday);

  while (cursor <= endDate) {
    const start = setTimeFromHHmm(cursor, startTimeHHmm);
    const end = new Date(start.getTime() + durationMinutes * 60_000);
    occurrences.push({ startTime: start, endTime: end });
    cursor = addDays(cursor, 7);
  }

  return occurrences;
};

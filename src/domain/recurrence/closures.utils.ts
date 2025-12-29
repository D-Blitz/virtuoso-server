export type ClosureRange = {
  startDate: Date;
  endDate: Date;
};

export const isInAnyClosure = (date: Date, closures: ClosureRange[]): boolean => {
  const time = date.getTime();
  return closures.some((c) => time >= c.startDate.getTime() && time <= c.endDate.getTime());
};

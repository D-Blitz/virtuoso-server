import { generateWeeklyOccurrences } from '../../domain/recurrence/weeklyRecurrence.utils';

export class EnrollmentEventGeneratorService {
  generate(params: {
    enrollment: {
      id: string;
      weekday: number;
      startTime: string;
      durationMinutes: number;
      startDate: Date;
      endDate: Date;
      serviceId: string;
      serviceCategoryId: string;
      locationId: string;
      roomId?: string | null;
      facilitatorId?: string | null;
      color: string;
    };
  }) {
    const { enrollment } = params;

    const occurrences = generateWeeklyOccurrences({
      startDate: enrollment.startDate,
      endDate: enrollment.endDate,
      weekday: enrollment.weekday,
      startTimeHHmm: enrollment.startTime,
      durationMinutes: enrollment.durationMinutes,
    });

    return occurrences.map((o) => ({
      startTime: o.startTime,
      endTime: o.endTime,
      serviceId: enrollment.serviceId,
      serviceCategoryId: enrollment.serviceCategoryId,
      locationId: enrollment.locationId,
      roomId: enrollment.roomId ?? undefined,
      enrollmentId: enrollment.id,
      color: enrollment.color,
      price: 0,
    }));
  }
}

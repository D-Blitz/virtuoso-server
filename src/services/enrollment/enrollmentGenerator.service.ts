import {
  generateEnrollmentOccurrences,
  type EnrollmentFrequency,
} from '../../domain/recurrence/enrollmentRecurrence.utils';

export class EnrollmentEventGeneratorService {
  generate(params: {
    enrollment: {
      id: string;
      // Phase B: optional frequency + customDates fields.
      frequency?: EnrollmentFrequency | string | null;
      weekday: number | null;
      startTime: string;
      durationMinutes: number;
      startDate: Date;
      endDate: Date;
      customDates?: string[] | null;
      serviceId: string;
      serviceCategoryId: string;
      locationId: string;
      roomId?: string | null;
      facilitatorId?: string | null;
      color: string;
    };
  }) {
    const { enrollment } = params;

    // Fall back to WEEKLY for legacy enrollments that pre-date the
    // frequency column (their stored value is the column default).
    const frequency: EnrollmentFrequency =
      (enrollment.frequency as EnrollmentFrequency) || 'WEEKLY';

    const occurrences = generateEnrollmentOccurrences({
      frequency,
      startDate: enrollment.startDate,
      endDate: enrollment.endDate,
      weekday: enrollment.weekday,
      startTime: enrollment.startTime,
      durationMinutes: enrollment.durationMinutes,
      customDates: enrollment.customDates ?? null,
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

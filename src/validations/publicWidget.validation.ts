import { z } from 'zod';

export const recommendationsBodySchema = z.object({
  serviceId: z.string().min(1),
  level: z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED']),
  languages: z.array(z.string().min(2)).default([]),
  studentAge: z.number().int().min(0).max(120),
  acceptNonNativeSpeaker: z.boolean(),
  locationId: z.string().optional(),
});

export const availabilityQuerySchema = z.object({
  serviceId: z.string().min(1),
  // facilitatorIds may arrive as a single string or as a comma-separated list.
  facilitatorIds: z
    .union([z.string(), z.array(z.string())])
    .transform((v) =>
      Array.isArray(v) ? v : v.split(',').map((s) => s.trim()).filter(Boolean),
    )
    .pipe(z.array(z.string().min(1)).min(1)),
  from: z.string().datetime(),
  to: z.string().datetime(),
  locationId: z.string().optional(),
});

export const createHoldBodySchema = z.object({
  facilitatorId: z.string().min(1),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  sessionId: z.string().min(1),
});

export const trialBookingBodySchema = z.object({
  holdId: z.string().min(1),
  sessionId: z.string().min(1),
  serviceId: z.string().min(1),
  facilitatorId: z.string().min(1),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  student: z.object({
    firstname: z.string().min(1),
    lastname: z.string().min(1),
    email: z.string().email(),
    phone: z.string().optional(),
    address: z.string().optional(),
    birthdate: z.string().optional(),
  }),
  languages: z.array(z.string()).default([]),
  level: z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED']),
  acceptedCgv: z
    .boolean()
    .refine((v) => v === true, { message: 'CGV acceptance is required.' }),
  cgvVersion: z.string().min(1),
  marketingOptIn: z.boolean().default(false),
});

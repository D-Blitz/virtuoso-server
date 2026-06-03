// Enrollment import spec.
//
// Enrollment is the recurring-purchase primitive: it binds Client +
// Service + Term + Room + (optional) Facilitator + billing snapshot
// + a weekly recurrence rule (weekday, startTime, durationMinutes,
// startDate, endDate). Generating events from an enrollment is a
// separate action — by default the importer also calls the same
// weekly generator after each successful upsert so a bulk import
// of 200 enrollments produces ~2,400 events in one step.
//
// Natural key for upsert: (organizationId, clientEmail, termName,
// serviceName). A single client can have multiple enrollments per
// term IF they're for different services, so this composite is the
// minimum-unique identifier. Re-importing the same triple updates
// the existing row.
//
// Derived FKs:
//   - locationId from Room.locationId
//   - serviceCategoryId is NOT stored on Enrollment (only on Service)
//     so no derivation needed for the row itself — the event
//     generator pulls it from the service when creating events.

import {
  parseDate,
  parseEnum,
  parseFloatNumber,
  parseInteger,
  parseString,
  parseTime,
} from '../parsers';
import {
  generateEnrollmentOccurrences,
  type EnrollmentFrequency,
} from '../../../domain/recurrence/enrollmentRecurrence.utils';
import { isInAnyClosure } from '../../../domain/recurrence/closures.utils';
import type { ImportContext, ImportEntitySpec } from '../types';

const WEEKDAY_LABEL_TO_NUMBER: Record<string, number> = {
  // Accept both French names and numeric strings 0-6.
  dimanche: 0,
  lundi: 1,
  mardi: 2,
  mercredi: 3,
  jeudi: 4,
  vendredi: 5,
  samedi: 6,
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

// Phase B (June 2026): pricing strategy values dropped the "TERM_"
// prefix — terms can be any duration (semesters, monthly, recital
// blocks). Existing rows were migrated by
// `20260602000001_rename_pricing_strategy_values`.
const PRICING_STRATEGIES = ['PERIOD_PRORATED', 'PERIOD_FIXED', 'PER_OCCURRENCE'] as const;
const STATUSES = ['DRAFT', 'PAID', 'ACTIVE', 'CANCELED'] as const;
const FREQUENCIES = ['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'DAILY', 'CUSTOM'] as const;

function parseWeekday(
  cell: string | undefined,
): { value?: number; error?: string } {
  const v = (cell ?? '').trim().toLowerCase();
  if (v.length === 0) return { error: 'Jour de la semaine est requis' };
  if (/^[0-6]$/.test(v)) return { value: Number(v) };
  const n = WEEKDAY_LABEL_TO_NUMBER[v];
  if (n === undefined) {
    return {
      error: `Jour invalide (reçu : "${cell}"). Accepté : 0–6 ou « lundi »/« mardi »/… `,
    };
  }
  return { value: n };
}

async function resolveClient(
  email: string,
  ctx: ImportContext,
): Promise<string | null> {
  const key = `client:${email.toLowerCase()}`;
  const cached = ctx.referenceCache.get(key);
  if (cached !== undefined) return cached;
  const row = await ctx.prisma.client.findFirst({
    where: { organizationId: ctx.organizationId, email },
    select: { id: true },
  });
  const id = row?.id ?? null;
  ctx.referenceCache.set(key, id);
  return id;
}

/**
 * Resolve a Service by name → returns id + serviceCategoryId +
 * defaults the enrollment can fall back to when its `durationMinutes`
 * / `priceCharged` cells are empty (the spec mirrors the manual
 * EnrollmentForm: both fields are seeded from the Service).
 *
 * The shared `referenceCache: Map<string, string|null>` only stores
 * ids, so the duration/price defaults get stashed under sibling keys
 * — same cardinality, same lookup, no separate Map.
 */
type ResolvedService = {
  id: string;
  serviceCategoryId: string;
  defaultDurationMinutes: number;
  defaultPrice: number;
};

async function resolveService(
  name: string,
  ctx: ImportContext,
): Promise<ResolvedService | null> {
  const idKey = `serviceForEnrollment:${name.toLowerCase()}`;
  const cachedId = ctx.referenceCache.get(idKey);
  if (cachedId === null) return null;
  if (cachedId !== undefined) {
    // Reconstruct from sibling keys cached on the same lookup.
    const catId = ctx.referenceCache.get(`serviceCategoryFor:${cachedId}`);
    const durRaw = ctx.referenceCache.get(`serviceDuration:${cachedId}`);
    const priceRaw = ctx.referenceCache.get(`servicePrice:${cachedId}`);
    if (catId && durRaw && priceRaw) {
      return {
        id: cachedId,
        serviceCategoryId: catId,
        defaultDurationMinutes: Number(durRaw),
        defaultPrice: Number(priceRaw),
      };
    }
    // Fall through to refetch if a sibling key is missing (e.g.
    // some other spec populated only the id).
  }
  const row = await ctx.prisma.service.findFirst({
    where: { organizationId: ctx.organizationId, name },
    select: {
      id: true,
      serviceCategoryId: true,
      defaultDurationMinutes: true,
      defaultPrice: true,
    },
  });
  if (!row) {
    ctx.referenceCache.set(idKey, null);
    return null;
  }
  ctx.referenceCache.set(idKey, row.id);
  ctx.referenceCache.set(`serviceCategoryFor:${row.id}`, row.serviceCategoryId);
  ctx.referenceCache.set(
    `serviceDuration:${row.id}`,
    String(row.defaultDurationMinutes),
  );
  ctx.referenceCache.set(`servicePrice:${row.id}`, String(row.defaultPrice));
  return row;
}

async function resolveRoom(
  name: string,
  ctx: ImportContext,
): Promise<{ id: string; locationId: string } | null> {
  const key = `roomForEnrollment:${name.toLowerCase()}`;
  const cached = ctx.referenceCache.get(key);
  if (cached === null) return null;
  if (cached !== undefined) {
    const loc = ctx.referenceCache.get(`locationForRoom:${cached}`);
    if (loc) return { id: cached, locationId: loc };
  }
  const row = await ctx.prisma.room.findFirst({
    where: { organizationId: ctx.organizationId, name },
    select: { id: true, locationId: true },
  });
  if (!row) {
    ctx.referenceCache.set(key, null);
    return null;
  }
  ctx.referenceCache.set(key, row.id);
  ctx.referenceCache.set(`locationForRoom:${row.id}`, row.locationId);
  return row;
}

async function resolveTerm(
  name: string,
  ctx: ImportContext,
): Promise<string | null> {
  const key = `term:${name.toLowerCase()}`;
  const cached = ctx.referenceCache.get(key);
  if (cached !== undefined) return cached;
  const row = await ctx.prisma.term.findFirst({
    where: { organizationId: ctx.organizationId, name },
    select: { id: true },
  });
  const id = row?.id ?? null;
  ctx.referenceCache.set(key, id);
  return id;
}

async function resolveFacilitator(
  nameOrEmail: string,
  ctx: ImportContext,
): Promise<string | null> {
  const key = `facilitator:${nameOrEmail.toLowerCase()}`;
  const cached = ctx.referenceCache.get(key);
  if (cached !== undefined) return cached;
  let row: { id: string } | null = null;
  if (nameOrEmail.includes('@')) {
    row = await ctx.prisma.facilitator.findFirst({
      where: { organizationId: ctx.organizationId, email: nameOrEmail },
      select: { id: true },
    });
  } else {
    const parts = nameOrEmail.split(/\s+/);
    const firstname = parts[0] ?? '';
    const lastname = parts.slice(1).join(' ');
    row = await ctx.prisma.facilitator.findFirst({
      where: lastname
        ? { organizationId: ctx.organizationId, firstname, lastname }
        : { organizationId: ctx.organizationId, firstname },
      select: { id: true },
    });
  }
  const id = row?.id ?? null;
  ctx.referenceCache.set(key, id);
  return id;
}

function combineDateAndTime(
  date: Date,
  time: { hours: number; minutes: number },
): Date {
  const d = new Date(date);
  d.setHours(time.hours, time.minutes, 0, 0);
  return d;
}

/**
 * Materialize the weekly events for an enrollment that was just
 * upserted. Skips occurrences in closures (same rule as the
 * generate-events controller endpoint). Idempotent: if the
 * enrollment already has events linked, we skip generation entirely
 * — same behaviour as the controller's 409 guard.
 *
 * Returns the count generated so the import result can report it.
 */
async function generateEventsForEnrollment(
  enrollmentId: string,
  ctx: ImportContext,
): Promise<number> {
  const enrollment = await ctx.prisma.enrollment.findUnique({
    where: { id: enrollmentId },
    include: { service: true },
  });
  if (!enrollment) return 0;

  const existingCount = await ctx.prisma.scheduledEvent.count({
    where: { enrollmentId, deletedAt: null },
  });
  if (existingCount > 0) return 0;

  const occurrences = generateEnrollmentOccurrences({
    frequency: ((enrollment.frequency as string) || 'WEEKLY') as EnrollmentFrequency,
    startDate: enrollment.startDate,
    endDate: enrollment.endDate,
    weekday: enrollment.weekday,
    startTime: enrollment.startTime,
    durationMinutes: enrollment.durationMinutes,
    customDates: (enrollment.customDates as string[] | null) ?? null,
  });

  if (occurrences.length === 0) return 0;

  const closures = await ctx.prisma.closure.findMany({
    where: {
      organizationId: ctx.organizationId,
      OR: [{ locationId: enrollment.locationId }, { locationId: null }],
      startDate: { lte: enrollment.endDate },
      endDate: { gte: enrollment.startDate },
    },
    select: { startDate: true, endDate: true },
  });
  const filtered = occurrences.filter(
    (o: { startTime: Date }) => !isInAnyClosure(o.startTime, closures),
  );
  if (filtered.length === 0) return 0;

  // Bulk create via createMany would be fastest but lacks `connect`
  // for the client/facilitator m2m. Use a transaction of individual
  // creates — same pattern as the controller.
  const orgId = ctx.organizationId;
  const created = await ctx.prisma.$transaction(
    filtered.map((o: { startTime: Date; endTime: Date }) =>
      ctx.prisma.scheduledEvent.create({
        data: {
          organizationId: orgId,
          startTime: o.startTime,
          endTime: o.endTime,
          color: '#8b5cf6',
          price: 0,
          notes: null,
          roomId: enrollment.roomId,
          locationId: enrollment.locationId,
          serviceId: enrollment.serviceId,
          serviceCategoryId: enrollment.service.serviceCategoryId,
          enrollmentId: enrollment.id,
          clients: { connect: [{ id: enrollment.clientId }] },
          ...(enrollment.facilitatorId
            ? { facilitators: { connect: [{ id: enrollment.facilitatorId }] } }
            : {}),
        },
        select: { id: true },
      }),
    ),
  );
  return created.length;
}

export const enrollmentSpec: ImportEntitySpec = {
  type: 'enrollment',
  label: 'Inscriptions',
  description:
    'Inscription récurrente (client × prestation × période). Importez d’abord les clients, prestations, périodes, salles et intervenants. Les événements hebdomadaires sont générés automatiquement (les jours de fermeture sont exclus).',
  uniqueBy: 'client+term+service',
  columns: [
    {
      key: 'client',
      label: 'Client',
      required: true,
      type: 'reference',
      referenceEntity: 'client',
      referenceColumn: 'email',
      description: 'Email du client — clé naturelle.',
      example: 'lea.durand@example.com',
    },
    {
      key: 'service',
      label: 'Prestation',
      required: true,
      type: 'reference',
      referenceEntity: 'service',
      referenceColumn: 'name',
      example: 'Piano débutant',
    },
    {
      key: 'term',
      label: 'Période',
      required: true,
      type: 'reference',
      referenceEntity: 'term',
      referenceColumn: 'name',
      description: 'Nom exact d’une période existante.',
      example: 'Trimestre 1 — 2026/2027',
    },
    {
      key: 'room',
      label: 'Salle',
      required: true,
      type: 'reference',
      referenceEntity: 'room',
      referenceColumn: 'name',
      description: 'Le lieu est déduit automatiquement de la salle.',
      example: 'Salle Mozart',
    },
    {
      key: 'facilitator',
      label: 'Intervenant',
      required: false,
      type: 'reference',
      referenceEntity: 'facilitator',
      referenceColumn: 'email',
      description: '« Prénom Nom » ou email — laissez vide si non assigné.',
    },
    {
      key: 'frequency',
      label: 'Fréquence',
      required: false,
      type: 'enum',
      enumValues: FREQUENCIES.slice(),
      description:
        'WEEKLY / BIWEEKLY / MONTHLY / DAILY / CUSTOM. Défaut : WEEKLY. Pour CUSTOM, renseignez customDates.',
      example: 'WEEKLY',
    },
    {
      key: 'weekday',
      label: 'Jour de la semaine',
      required: false,
      type: 'string',
      description:
        '0–6 (0 = dimanche) ou « lundi » / … — requis pour WEEKLY / BIWEEKLY / MONTHLY, ignoré sinon.',
      example: 'mardi',
    },
    {
      key: 'customDates',
      label: 'Dates personnalisées',
      required: false,
      type: 'string',
      description:
        'Pour frequency=CUSTOM uniquement. Datetimes ISO séparés par "|" (ex : 2026-09-15T17:00:00|2026-09-22T17:00:00).',
      example: '2026-09-15T17:00:00|2026-09-22T17:00:00',
    },
    {
      key: 'startTime',
      label: 'Heure de début',
      required: true,
      type: 'string',
      description: 'Format HH:MM (24h).',
      example: '17:00',
    },
    {
      key: 'durationMinutes',
      label: 'Durée (min)',
      required: false,
      type: 'integer',
      description:
        'Optionnel — laisser vide pour utiliser la durée par défaut de la prestation.',
      example: '60',
    },
    {
      key: 'startDate',
      label: 'Date de début',
      required: true,
      type: 'date',
      description: 'Première occurrence possible (ISO yyyy-mm-dd).',
      example: '2026-09-15',
    },
    {
      key: 'endDate',
      label: 'Date de fin',
      required: true,
      type: 'date',
      example: '2026-12-19',
    },
    {
      key: 'priceCharged',
      label: 'Tarif facturé (€)',
      required: false,
      type: 'number',
      description:
        'Optionnel — laisser vide pour utiliser le tarif par défaut de la prestation.',
      example: '350',
    },
    {
      key: 'pricingStrategy',
      label: 'Stratégie tarifaire',
      required: false,
      type: 'enum',
      enumValues: PRICING_STRATEGIES.slice(),
      description: 'Défaut : PERIOD_PRORATED.',
    },
    {
      key: 'status',
      label: 'Statut',
      required: false,
      type: 'enum',
      enumValues: STATUSES.slice(),
      description: 'Défaut : ACTIVE.',
    },
  ],

  async parseRow(row, ctx) {
    const errors: string[] = [];
    const warnings: string[] = [];

    const clientEmail = parseString(row.client, {
      required: true,
      label: 'Client',
    });
    if (clientEmail.error) errors.push(clientEmail.error);
    const serviceName = parseString(row.service, {
      required: true,
      label: 'Prestation',
    });
    if (serviceName.error) errors.push(serviceName.error);
    const termName = parseString(row.term, {
      required: true,
      label: 'Période',
    });
    if (termName.error) errors.push(termName.error);
    const roomName = parseString(row.room, {
      required: true,
      label: 'Salle',
    });
    if (roomName.error) errors.push(roomName.error);
    const facilitatorName = parseString(row.facilitator);

    // Frequency drives which of weekday / customDates is required.
    const frequencyParsed = parseEnum(row.frequency, FREQUENCIES, {
      label: 'Fréquence',
      default: 'WEEKLY',
    });
    if (frequencyParsed.error) errors.push(frequencyParsed.error);
    const effectiveFrequency = frequencyParsed.value ?? 'WEEKLY';
    const needsWeekday =
      effectiveFrequency === 'WEEKLY' ||
      effectiveFrequency === 'BIWEEKLY' ||
      effectiveFrequency === 'MONTHLY';
    const isCustom = effectiveFrequency === 'CUSTOM';

    // weekday is conditionally required.
    const weekdayRaw = (row.weekday ?? '').trim();
    let weekdayValue: number | null = null;
    if (weekdayRaw.length > 0) {
      const wd = parseWeekday(row.weekday);
      if (wd.error) errors.push(wd.error);
      else weekdayValue = wd.value ?? null;
    } else if (needsWeekday) {
      errors.push(
        `Jour de la semaine requis pour la fréquence ${effectiveFrequency}.`,
      );
    }

    // customDates: pipe-separated ISO strings, only used when
    // frequency=CUSTOM. We parse aggressively (each entry must be a
    // valid Date) so bad data fails the row at preview rather than
    // commit.
    let customDatesValue: string[] | null = null;
    const customDatesRaw = (row.customDates ?? '').trim();
    if (isCustom) {
      if (customDatesRaw.length === 0) {
        errors.push('customDates requis pour la fréquence CUSTOM.');
      } else {
        const parts = customDatesRaw
          .split('|')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        const bad = parts.filter((p) => Number.isNaN(new Date(p).getTime()));
        if (bad.length > 0) {
          errors.push(
            `customDates : datetime(s) invalide(s) — ${bad.join(', ')}.`,
          );
        } else if (parts.length === 0) {
          errors.push('customDates ne contient aucune date valide.');
        } else {
          customDatesValue = parts.map((p) => new Date(p).toISOString());
        }
      }
    } else if (customDatesRaw.length > 0) {
      // Admin filled the column but the frequency doesn't use it —
      // surface a soft warning so they know it'll be ignored.
      warnings.push(
        `customDates renseigné mais ignoré pour la fréquence ${effectiveFrequency}.`,
      );
    }

    const startTime = parseTime(row.startTime, {
      required: true,
      label: 'Heure de début',
    });
    if (startTime.error) errors.push(startTime.error);
    // Duration + price are OPTIONAL on import — empty cell falls
    // back to the resolved Service's defaults. Matches the manual
    // EnrollmentForm UX (the form pre-fills from the service and
    // lets the admin override per enrollment).
    const duration = parseInteger(row.durationMinutes, {
      required: false,
      label: 'Durée',
      min: 1,
      max: 24 * 60,
    });
    if (duration.error) errors.push(duration.error);
    const startDate = parseDate(row.startDate, {
      required: true,
      label: 'Date de début',
    });
    if (startDate.error) errors.push(startDate.error);
    const endDate = parseDate(row.endDate, {
      required: true,
      label: 'Date de fin',
    });
    if (endDate.error) errors.push(endDate.error);
    if (
      startDate.value &&
      endDate.value &&
      startDate.value.getTime() > endDate.value.getTime()
    ) {
      errors.push('La date de début doit être avant la date de fin');
    }
    const price = parseFloatNumber(row.priceCharged, {
      required: false,
      label: 'Tarif',
      min: 0,
    });
    if (price.error) errors.push(price.error);
    const pricingStrategy = parseEnum(row.pricingStrategy, PRICING_STRATEGIES, {
      label: 'Stratégie tarifaire',
      default: 'PERIOD_PRORATED',
    });
    if (pricingStrategy.error) errors.push(pricingStrategy.error);
    const status = parseEnum(row.status, STATUSES, {
      label: 'Statut',
      default: 'ACTIVE',
    });
    if (status.error) errors.push(status.error);

    // Resolve required FKs — hard errors.
    let clientId: string | null = null;
    let serviceId: string | null = null;
    let termId: string | null = null;
    let roomId: string | null = null;
    let locationId: string | null = null;
    let facilitatorId: string | null = null;
    // Defaults pulled from the Service for the duration / price
    // fallback. Stays null until we successfully resolve the service.
    let serviceDefaultDuration: number | null = null;
    let serviceDefaultPrice: number | null = null;

    if (clientEmail.value) {
      clientId = await resolveClient(clientEmail.value, ctx);
      if (!clientId) errors.push(`Client "${clientEmail.value}" introuvable.`);
    }
    if (serviceName.value) {
      const svc = await resolveService(serviceName.value, ctx);
      if (!svc) {
        errors.push(`Prestation "${serviceName.value}" introuvable.`);
      } else {
        serviceId = svc.id;
        serviceDefaultDuration = svc.defaultDurationMinutes;
        serviceDefaultPrice = svc.defaultPrice;
      }
    }
    if (termName.value) {
      termId = await resolveTerm(termName.value, ctx);
      if (!termId) errors.push(`Période "${termName.value}" introuvable.`);
    }
    if (roomName.value) {
      const rm = await resolveRoom(roomName.value, ctx);
      if (!rm) {
        errors.push(`Salle "${roomName.value}" introuvable.`);
      } else {
        roomId = rm.id;
        locationId = rm.locationId;
      }
    }
    // Facilitator is OPTIONAL — miss is a warning, not an error.
    if (facilitatorName.value) {
      facilitatorId = await resolveFacilitator(facilitatorName.value, ctx);
      if (!facilitatorId) {
        warnings.push(
          `Intervenant "${facilitatorName.value}" introuvable — laissé non assigné.`,
        );
      }
    }

    if (errors.length > 0) return { errors, warnings };

    // Compute the active window. startDate / endDate from the CSV
    // are date-only; the recurrence rule wants Datetimes. We anchor
    // both at the start time so the weekly generator's [start, end]
    // window covers the correct calendar range.
    const startAt = combineDateAndTime(startDate.value!, startTime.value!);
    const endAt = combineDateAndTime(endDate.value!, startTime.value!);
    const startTimeHHmm = `${String(startTime.value!.hours).padStart(2, '0')}:${String(startTime.value!.minutes).padStart(2, '0')}`;

    // Apply the service-default fallback. If the CSV cell was empty
    // AND we successfully resolved the service, use the service's
    // default. Otherwise (empty cell + unresolvable service — which
    // is itself a hard error already pushed above) fall back to a
    // safe default of 60min / 0€ so the payload typechecks; the
    // outer error array still blocks the row.
    const effectiveDuration =
      duration.value ?? serviceDefaultDuration ?? 60;
    const effectivePrice = price.value ?? serviceDefaultPrice ?? 0;

    return {
      warnings: warnings.length > 0 ? warnings : undefined,
      data: {
        clientId,
        serviceId,
        termId,
        roomId,
        locationId,
        facilitatorId,
        frequency: effectiveFrequency,
        // weekday is null for DAILY / CUSTOM and that's intentional;
        // schema is nullable post-migration.
        weekday: weekdayValue,
        startTime: startTimeHHmm,
        durationMinutes: effectiveDuration,
        startDate: startAt,
        endDate: endAt,
        customDates: customDatesValue,
        priceCharged: effectivePrice,
        pricingStrategy: pricingStrategy.value ?? 'PERIOD_PRORATED',
        status: status.value ?? 'ACTIVE',
      },
    };
  },

  async upsert(data, ctx) {
    // Composite natural key: (organizationId, clientId, termId, serviceId).
    // Same client + same term + same service = same enrollment.
    const existing = await ctx.prisma.enrollment.findFirst({
      where: {
        organizationId: ctx.organizationId,
        clientId: data.clientId as string,
        termId: data.termId as string,
        serviceId: data.serviceId as string,
        deletedAt: null,
      },
      select: { id: true },
    });

    const scalars = {
      clientId: data.clientId as string,
      serviceId: data.serviceId as string,
      termId: data.termId as string,
      roomId: data.roomId as string,
      locationId: data.locationId as string,
      facilitatorId: (data.facilitatorId as string | null) ?? null,
      frequency: (data.frequency as string) ?? 'WEEKLY',
      weekday: (data.weekday as number | null) ?? null,
      startTime: data.startTime as string,
      durationMinutes: data.durationMinutes as number,
      startDate: data.startDate as Date,
      endDate: data.endDate as Date,
      customDates: (data.customDates as string[] | null) ?? null,
      priceCharged: data.priceCharged as number,
      pricingStrategy: data.pricingStrategy as string,
      status: data.status as string,
    };

    let id: string;
    let action: 'created' | 'updated';
    if (existing) {
      await ctx.prisma.enrollment.update({
        where: { id: existing.id },
        data: scalars,
      });
      id = existing.id;
      action = 'updated';
    } else {
      const created = await ctx.prisma.enrollment.create({
        data: { organizationId: ctx.organizationId, ...scalars },
        select: { id: true },
      });
      id = created.id;
      action = 'created';
    }

    // Auto-generate events for new enrollments. For updates we skip
    // generation — the event generator's idempotency guard would skip
    // anyway if events already exist, but explicitly skipping makes
    // re-imports cheap. Admins who want to regenerate after editing
    // the rule should DELETE the events first via the
    // /:id/events endpoint.
    if (action === 'created') {
      await generateEventsForEnrollment(id, ctx);
    }

    return { id, action };
  },

  async exportRows(ctx) {
    const rows = await ctx.prisma.enrollment.findMany({
      where: { organizationId: ctx.organizationId, deletedAt: null },
      orderBy: [{ termId: 'asc' }, { clientId: 'asc' }],
      select: {
        frequency: true,
        weekday: true,
        startTime: true,
        durationMinutes: true,
        startDate: true,
        endDate: true,
        customDates: true,
        priceCharged: true,
        pricingStrategy: true,
        status: true,
        client: { select: { email: true } },
        service: { select: { name: true } },
        term: { select: { name: true } },
        room: { select: { name: true } },
        facilitator: { select: { email: true } },
      },
    });
    const pad = (n: number) => String(n).padStart(2, '0');
    const isoDate = (d: Date) =>
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return rows.map(
      (r: {
        frequency: string;
        weekday: number | null;
        startTime: string;
        durationMinutes: number;
        startDate: Date;
        endDate: Date;
        customDates: unknown;
        priceCharged: number;
        pricingStrategy: string;
        status: string;
        client: { email: string } | null;
        service: { name: string } | null;
        term: { name: string } | null;
        room: { name: string } | null;
        facilitator: { email: string } | null;
      }) => ({
        client: r.client?.email ?? '',
        service: r.service?.name ?? '',
        term: r.term?.name ?? '',
        room: r.room?.name ?? '',
        facilitator: r.facilitator?.email ?? '',
        frequency: r.frequency,
        weekday: r.weekday == null ? '' : String(r.weekday),
        startTime: r.startTime,
        durationMinutes: String(r.durationMinutes),
        startDate: isoDate(r.startDate),
        endDate: isoDate(r.endDate),
        // customDates round-trips through the pipe-separated format
        // the importer accepts. Empty when not CUSTOM-frequency.
        customDates: Array.isArray(r.customDates)
          ? (r.customDates as string[]).join('|')
          : '',
        priceCharged: String(r.priceCharged),
        pricingStrategy: r.pricingStrategy,
        status: r.status,
      }),
    );
  },
};

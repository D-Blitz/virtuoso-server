// ScheduledEvent import spec.
//
// One CSV row = one concrete event, OR one whole recurring series when
// the optional `frequency` + `recurrenceEndDate` pair is filled in.
// Leaving them empty keeps the original behaviour: bulk-loading
// pre-materialized occurrences (e.g. a term schedule exported from
// another tool, or an export from this app that's been edited).
//
// Recurrence reuses the same generator as the calendar form
// (services/recurrence) and produces the same shape: one
// RecurrenceSeries row plus N ScheduledEvent occurrences carrying its
// seriesId. Nothing about a series created here is special-cased.
//
// Schema requires 4 FKs: room, location, service, serviceCategory.
// We derive `location` from the Room and `serviceCategory` from the
// Service — admins only supply room + service in the CSV. This
// matches what ScheduledEventService.create() does for the calendar
// form and prevents inconsistencies between hand-typed FKs.
//
// endTime and price are optional: an empty cell inherits the Service's
// defaultDurationMinutes / defaultPrice. Mirrors the enrollment spec,
// which has always worked this way — requiring them per row duplicated
// data the Service already owns, and let the two drift apart.
//
// Natural key for upsert: (organizationId, date, startTime, roomId)
// — there's no @@unique in the schema, but this composite is what
// "the same calendar slot" means functionally. Re-running the same
// CSV after edits updates the existing row instead of duplicating.

import {
  parseDate,
  parseEnum,
  parseFloatNumber,
  parseHexColor,
  parseMultiReference,
  parseString,
  parseTime,
} from '../parsers';
import {
  FREQUENCIES,
  generateOccurrences,
  type Frequency,
  type Occurrence,
} from '../../recurrence/recurrence';
import type { ImportContext, ImportEntitySpec } from '../types';

/**
 * Fallback for an empty `color` cell. Neutral grey rather than a brand
 * colour: an imported event with no colour of its own shouldn't look
 * deliberately categorised on the planning board.
 *
 * Same value ScheduledEventService already falls back to when creating
 * a recurrence series without a colour (`rest.color ?? '#999999'`), so
 * the calendar form and the import agree.
 */
const DEFAULT_EVENT_COLOR = '#999999';

type ResolvedEventService = {
  id: string;
  serviceCategoryId: string;
  defaultDurationMinutes: number;
  defaultPrice: number;
};

/**
 * Resolve a Service by name → returns the derived serviceCategoryId
 * plus the defaults that back the optional endTime / price columns,
 * all in one query. Cached so a CSV with 1000 events on 5 services
 * only hits the DB 5 times.
 *
 * The sibling cache keys (`serviceCategoryFor:` / `serviceDuration:` /
 * `servicePrice:`) are deliberately the same ones the enrollment spec
 * writes, so an import touching both entity types warms them once.
 */
async function resolveServiceForEvent(
  name: string,
  ctx: ImportContext,
): Promise<ResolvedEventService | null> {
  const idKey = `serviceForEvent:${name.toLowerCase()}`;
  const cachedId = ctx.referenceCache.get(idKey);
  if (cachedId === null) return null;
  if (cachedId !== undefined) {
    // referenceCache is Map<string, string|null>, so the numbers are
    // stored stringified and rehydrated here.
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
    // A sibling key is missing (another spec cached only the id) —
    // fall through and refetch.
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

/**
 * Resolve a Room by name → returns { id, locationId } so we can
 * derive the event's locationId without a second query.
 */
async function resolveRoomForEvent(
  name: string,
  ctx: ImportContext,
): Promise<{ id: string; locationId: string } | null> {
  const key = `roomForEvent:${name.toLowerCase()}`;
  const cached = ctx.referenceCache.get(key);
  if (cached !== undefined && cached !== null) {
    const locKey = `locationForRoom:${cached}`;
    const cachedLoc = ctx.referenceCache.get(locKey);
    if (cachedLoc) return { id: cached, locationId: cachedLoc };
  }
  if (cached === null) return null;
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

/**
 * Resolve facilitators by either "firstname lastname" or email.
 * Misses become row warnings (m2m, dropped from this row).
 */
async function resolveFacilitators(
  names: string[],
  ctx: ImportContext,
): Promise<{ ids: string[]; missing: string[] }> {
  const ids: string[] = [];
  const missing: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const cacheKey = `facilitator:${name.toLowerCase()}`;
    const cached = ctx.referenceCache.get(cacheKey);
    if (cached === null) {
      missing.push(name);
      continue;
    }
    if (cached !== undefined) {
      ids.push(cached);
      continue;
    }
    let row: { id: string } | null = null;
    if (name.includes('@')) {
      row = await ctx.prisma.facilitator.findFirst({
        where: { organizationId: ctx.organizationId, email: name },
        select: { id: true },
      });
    } else {
      const parts = name.split(/\s+/);
      const firstname = parts[0] ?? '';
      const lastname = parts.slice(1).join(' ');
      row = await ctx.prisma.facilitator.findFirst({
        where: lastname
          ? { organizationId: ctx.organizationId, firstname, lastname }
          : { organizationId: ctx.organizationId, firstname },
        select: { id: true },
      });
    }
    if (row) {
      ctx.referenceCache.set(cacheKey, row.id);
      ids.push(row.id);
    } else {
      ctx.referenceCache.set(cacheKey, null);
      missing.push(name);
    }
  }
  return { ids, missing };
}

/** Resolve clients by email (Client.email is the natural key). */
async function resolveClients(
  emails: string[],
  ctx: ImportContext,
): Promise<{ ids: string[]; missing: string[] }> {
  const ids: string[] = [];
  const missing: string[] = [];
  for (const raw of emails) {
    const email = raw.trim().toLowerCase();
    if (!email) continue;
    const cacheKey = `client:${email}`;
    const cached = ctx.referenceCache.get(cacheKey);
    if (cached === null) {
      missing.push(email);
      continue;
    }
    if (cached !== undefined) {
      ids.push(cached);
      continue;
    }
    const row = await ctx.prisma.client.findFirst({
      where: { organizationId: ctx.organizationId, email },
      select: { id: true },
    });
    if (row) {
      ctx.referenceCache.set(cacheKey, row.id);
      ids.push(row.id);
    } else {
      ctx.referenceCache.set(cacheKey, null);
      missing.push(email);
    }
  }
  return { ids, missing };
}

/** Resolve tags by label. */
async function resolveTags(
  labels: string[],
  ctx: ImportContext,
): Promise<{ ids: string[]; missing: string[] }> {
  const ids: string[] = [];
  const missing: string[] = [];
  for (const raw of labels) {
    const label = raw.trim();
    if (!label) continue;
    const cacheKey = `tag:${label.toLowerCase()}`;
    const cached = ctx.referenceCache.get(cacheKey);
    if (cached === null) {
      missing.push(label);
      continue;
    }
    if (cached !== undefined) {
      ids.push(cached);
      continue;
    }
    const row = await ctx.prisma.tag.findFirst({
      where: { organizationId: ctx.organizationId, label },
      select: { id: true },
    });
    if (row) {
      ctx.referenceCache.set(cacheKey, row.id);
      ids.push(row.id);
    } else {
      ctx.referenceCache.set(cacheKey, null);
      missing.push(label);
    }
  }
  return { ids, missing };
}

/**
 * Resolve an Enrollment by its composite natural key:
 * `clientEmail|termName|serviceName`. Pipe-separated (commas mean
 * multi-value cells in our convention). Returns the enrollment id
 * + a quick snapshot used to validate event/enrollment consistency.
 */
async function resolveEnrollment(
  composite: string,
  ctx: ImportContext,
): Promise<
  | { id: string; serviceId: string; roomId: string; clientId: string }
  | null
> {
  const key = `enrollment:${composite.toLowerCase()}`;
  const cached = ctx.referenceCache.get(key);
  if (cached === null) return null;
  if (cached !== undefined) {
    // Re-fetch the validation snapshot when we have only the id
    // cached (cheaper than caching the whole shape).
    const row = await ctx.prisma.enrollment.findUnique({
      where: { id: cached },
      select: { id: true, serviceId: true, roomId: true, clientId: true },
    });
    return row ?? null;
  }
  const parts = composite.split('|').map((p) => p.trim());
  if (parts.length !== 3) {
    ctx.referenceCache.set(key, null);
    return null;
  }
  const [clientEmail, termName, serviceName] = parts;
  const row = await ctx.prisma.enrollment.findFirst({
    where: {
      organizationId: ctx.organizationId,
      deletedAt: null,
      client: { email: clientEmail },
      term: { name: termName },
      service: { name: serviceName },
    },
    select: { id: true, serviceId: true, roomId: true, clientId: true },
  });
  if (!row) {
    ctx.referenceCache.set(key, null);
    return null;
  }
  ctx.referenceCache.set(key, row.id);
  return row;
}

/**
 * Detect conflicts: events on the same room whose time range overlaps
 * with this row's [start, end). Excludes soft-deleted rows AND the
 * event we're about to upsert into (same composite key) — re-importing
 * an unchanged row shouldn't warn about itself.
 */
async function detectConflicts(
  ctx: ImportContext,
  roomId: string,
  start: Date,
  end: Date,
): Promise<{ id: string; startTime: Date; endTime: Date }[]> {
  return await ctx.prisma.scheduledEvent.findMany({
    where: {
      organizationId: ctx.organizationId,
      roomId,
      deletedAt: null,
      // overlap test: existing.start < new.end AND existing.end > new.start
      startTime: { lt: end },
      endTime: { gt: start },
      // Exclude the slot we're upserting into so re-imports stay quiet.
      NOT: { startTime: start },
    },
    select: { id: true, startTime: true, endTime: true },
    take: 5, // cap the warning's verbosity
  });
}

function combineDateAndTime(date: Date, time: { hours: number; minutes: number }): Date {
  const d = new Date(date);
  d.setHours(time.hours, time.minutes, 0, 0);
  return d;
}

function formatTimeLabel(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export const scheduledEventSpec: ImportEntitySpec = {
  type: 'scheduledEvent',
  label: 'Événements',
  description:
    'Cours, ateliers, rendez-vous programmés. Une ligne = un créneau concret. Importez d’abord vos lieux, salles, prestations, intervenants et clients. Pour des séries récurrentes, utilisez le formulaire du calendrier (la récurrence n’est pas exprimable dans le CSV).',
  // Composite natural key: (date, startTime, room). The string here
  // is informational only — the actual upsert lookup is implemented
  // in `upsert` below.
  uniqueBy: 'date+startTime+room',
  columns: [
    {
      key: 'date',
      label: 'Date',
      required: true,
      type: 'date',
      description: 'Format ISO yyyy-mm-dd. Combiné avec startTime / endTime.',
      example: '2026-09-15',
    },
    {
      key: 'startTime',
      label: 'Heure de début',
      required: true,
      type: 'string',
      description: 'Format HH:MM (24h).',
      example: '14:00',
    },
    {
      key: 'endTime',
      label: 'Heure de fin',
      required: false,
      type: 'string',
      description:
        'Format HH:MM (24h), après startTime. Laissez vide pour appliquer la durée par défaut de la prestation.',
      example: '15:00',
    },
    {
      key: 'service',
      label: 'Prestation',
      required: true,
      type: 'reference',
      referenceEntity: 'service',
      referenceColumn: 'name',
      description:
        'Nom exact de la prestation. La catégorie est déduite automatiquement.',
      example: 'Piano débutant',
    },
    {
      key: 'room',
      label: 'Salle',
      required: true,
      type: 'reference',
      referenceEntity: 'room',
      referenceColumn: 'name',
      description: 'Nom exact de la salle. Le lieu est déduit automatiquement.',
      example: 'Salle Mozart',
    },
    {
      key: 'facilitators',
      label: 'Intervenants',
      required: true,
      type: 'multiReference',
      referenceEntity: 'facilitator',
      referenceColumn: 'name',
      description:
        '« Prénom Nom » ou email — séparés par des virgules. Au moins un est requis.',
      example: 'Jean Dupont',
    },
    {
      key: 'clients',
      label: 'Clients',
      required: false,
      type: 'multiReference',
      referenceEntity: 'client',
      referenceColumn: 'email',
      description:
        'Emails de clients séparés par des virgules. Laissez vide pour un créneau sans inscrits.',
    },
    {
      key: 'color',
      label: 'Couleur',
      required: false,
      type: 'string',
      description:
        'Couleur hex (#abc ou #aabbcc) — affichage sur le planning. Laissez vide pour un gris neutre (#999999).',
      example: '#5b5bff',
    },
    {
      key: 'price',
      label: 'Tarif (€)',
      required: false,
      type: 'number',
      description:
        'Décimales avec . ou ,. Laissez vide pour appliquer le tarif par défaut de la prestation — 0 reste une valeur valide (événement offert).',
      example: '35.00',
    },
    {
      key: 'notes',
      label: 'Notes',
      required: false,
      type: 'string',
    },
    {
      key: 'tags',
      label: 'Étiquettes',
      required: false,
      type: 'multiReference',
      referenceEntity: 'tag',
      referenceColumn: 'label',
      description: 'Libellés d’étiquettes séparés par des virgules.',
    },
    {
      key: 'frequency',
      label: 'Récurrence',
      required: false,
      type: 'enum',
      enumValues: FREQUENCIES.slice(),
      description:
        'Laissez vide pour un événement unique. Renseigné, la ligne décrit toute une série : les occurrences sont générées de la date de début jusqu’à recurrenceEndDate. Exige recurrenceEndDate.',
      example: 'WEEKLY',
    },
    {
      key: 'recurrenceEndDate',
      label: 'Fin de récurrence',
      required: false,
      type: 'date',
      description:
        'Format ISO yyyy-mm-dd, incluse. Dernière date à laquelle une occurrence peut tomber. Obligatoire si frequency est renseigné, ignorée sinon.',
      example: '2026-12-19',
    },
    {
      key: 'enrollment',
      label: 'Inscription liée',
      required: false,
      // 'reference' rather than 'multiReference' — single composite
      // key value, not a list. Format below.
      type: 'reference',
      referenceEntity: 'enrollment',
      referenceColumn: 'composite',
      description:
        'Format : clientEmail|nomPériode|nomPrestation (3 segments séparés par |). Laissez vide pour un événement autonome.',
      example: 'lea.durand@example.com|Trimestre 1 — 2026/2027|Piano débutant',
    },
  ],

  async parseRow(row, ctx) {
    const errors: string[] = [];
    const warnings: string[] = [];

    const date = parseDate(row.date, { required: true, label: 'Date' });
    if (date.error) errors.push(date.error);
    const startTime = parseTime(row.startTime, {
      required: true,
      label: 'Heure de début',
    });
    if (startTime.error) errors.push(startTime.error);
    // Optional: an empty cell means "use the service's default
    // duration". `end` can't be computed until the service resolves,
    // so it's derived further down.
    const endTime = parseTime(row.endTime, { label: 'Heure de fin' });
    if (endTime.error) errors.push(endTime.error);

    let start: Date | null = null;
    if (date.value && startTime.value) {
      start = combineDateAndTime(date.value, startTime.value);
    }

    const serviceName = parseString(row.service, {
      required: true,
      label: 'Prestation',
    });
    if (serviceName.error) errors.push(serviceName.error);
    const roomName = parseString(row.room, { required: true, label: 'Salle' });
    if (roomName.error) errors.push(roomName.error);

    // Optional: an empty cell takes the neutral grey. A malformed one
    // is still an error — silently recolouring a typo would hide it.
    const color = parseHexColor(row.color, {
      label: 'Couleur',
      default: DEFAULT_EVENT_COLOR,
    });
    if (color.error) errors.push(color.error);
    // Optional: an empty cell means "use the service's default price".
    // An explicit 0 is preserved — `??` only falls back on null.
    const price = parseFloatNumber(row.price, { label: 'Tarif', min: 0 });
    if (price.error) errors.push(price.error);
    const notes = parseString(row.notes);

    const facNames = parseMultiReference(row.facilitators, {
      required: true,
      label: 'Intervenants',
    });
    if (facNames.error) errors.push(facNames.error);
    const clientEmails = parseMultiReference(row.clients, { label: 'Clients' });
    if (clientEmails.error) errors.push(clientEmails.error);
    const tagLabels = parseMultiReference(row.tags, { label: 'Étiquettes' });
    if (tagLabels.error) errors.push(tagLabels.error);
    // Optional enrollment linkage — single composite-key string, not
    // a list, so we use parseString.
    const enrollmentRef = parseString(row.enrollment, { label: 'Inscription' });
    if (enrollmentRef.error) errors.push(enrollmentRef.error);

    // Resolve FKs. Service + Room failures are HARD ERRORS (required
    // FK in schema, no nullable fallback). M2M failures are warnings.
    let serviceId: string | null = null;
    let serviceCategoryId: string | null = null;
    let roomId: string | null = null;
    let locationId: string | null = null;
    // Back the optional endTime / price columns. Stay null until the
    // service resolves.
    let serviceDefaultDuration: number | null = null;
    let serviceDefaultPrice: number | null = null;
    if (serviceName.value) {
      const svc = await resolveServiceForEvent(serviceName.value, ctx);
      if (!svc) {
        errors.push(`Prestation "${serviceName.value}" introuvable.`);
      } else {
        serviceId = svc.id;
        serviceCategoryId = svc.serviceCategoryId;
        serviceDefaultDuration = svc.defaultDurationMinutes;
        serviceDefaultPrice = svc.defaultPrice;
      }
    }

    // Derive the end. An explicit endTime is combined with the row's
    // date and must be strictly after the start. An empty cell falls
    // back to the service's default duration — Service
    // .defaultDurationMinutes is non-nullable, so once the service
    // resolved the fallback is always available. The trailing `?? 60`
    // only applies when the service did NOT resolve, and that row is
    // already failing on the "Prestation introuvable" error above; it
    // just keeps the payload well-formed until the errors are returned.
    //
    // Adding minutes to the start also handles an event that runs past
    // midnight, which the explicit-endTime path cannot express (an
    // endTime of 00:30 combines with the same date and lands before
    // the start).
    let end: Date | null = null;
    if (start) {
      if (endTime.value) {
        end = combineDateAndTime(date.value!, endTime.value);
        if (end.getTime() <= start.getTime()) {
          errors.push(
            "L'heure de fin doit être strictement après l'heure de début",
          );
        }
      } else {
        end = new Date(
          start.getTime() + (serviceDefaultDuration ?? 60) * 60_000,
        );
      }
    }

    // ── Optional recurrence ──────────────────────────────────────
    // The two columns travel together: a frequency with no end date is
    // unbounded, and an end date with no frequency has nothing to
    // repeat. Either one alone is a mistake worth surfacing rather than
    // quietly ignoring.
    const frequency = parseEnum(row.frequency, FREQUENCIES, {
      label: 'Récurrence',
    });
    if (frequency.error) errors.push(frequency.error);
    const recurrenceEnd = parseDate(row.recurrenceEndDate, {
      label: 'Fin de récurrence',
    });
    if (recurrenceEnd.error) errors.push(recurrenceEnd.error);

    if (frequency.value && !recurrenceEnd.value) {
      errors.push(
        'recurrenceEndDate est requis lorsque frequency est renseigné.',
      );
    }
    if (!frequency.value && recurrenceEnd.value) {
      errors.push(
        'frequency est requis lorsque recurrenceEndDate est renseigné.',
      );
    }

    // Generate at parse time, not at commit time, so a rule that blows
    // the 500-occurrence cap fails during the preview — where the admin
    // can see and fix it — instead of part-way through writing.
    let occurrences: Occurrence[] | null = null;
    let recurrenceBoundary: Date | null = null;
    if (frequency.value && recurrenceEnd.value && start && end) {
      // The column names a day; treat it as end-of-day so an occurrence
      // landing on that date is included, matching "incluse" in the doc.
      recurrenceBoundary = new Date(recurrenceEnd.value);
      recurrenceBoundary.setHours(23, 59, 59, 999);
      if (recurrenceBoundary.getTime() < start.getTime()) {
        errors.push('recurrenceEndDate doit être à la date de début ou après.');
      } else {
        try {
          occurrences = generateOccurrences({
            frequency: frequency.value as Frequency,
            startDate: start,
            endDate: recurrenceBoundary,
            durationMs: end.getTime() - start.getTime(),
          });
        } catch (err) {
          errors.push(
            err instanceof Error ? err.message : 'Récurrence invalide.',
          );
        }
      }
    }
    if (roomName.value) {
      const rm = await resolveRoomForEvent(roomName.value, ctx);
      if (!rm) {
        errors.push(`Salle "${roomName.value}" introuvable.`);
      } else {
        roomId = rm.id;
        locationId = rm.locationId;
      }
    }

    const facResolved = await resolveFacilitators(facNames.value ?? [], ctx);
    facResolved.missing.forEach((n) =>
      warnings.push(
        `Intervenant "${n}" introuvable — relation ignorée pour cette ligne.`,
      ),
    );
    if (facNames.value && facResolved.ids.length === 0) {
      // Facilitator is required ≥1 per our spec; if every entry was
      // missing the row has no facilitator at all → hard error.
      errors.push('Au moins un intervenant valide est requis.');
    }
    const clientResolved = await resolveClients(clientEmails.value ?? [], ctx);
    clientResolved.missing.forEach((email) =>
      warnings.push(
        `Client "${email}" introuvable — relation ignorée pour cette ligne.`,
      ),
    );
    const tagResolved = await resolveTags(tagLabels.value ?? [], ctx);
    tagResolved.missing.forEach((label) =>
      warnings.push(
        `Étiquette "${label}" introuvable — relation ignorée pour cette ligne.`,
      ),
    );

    // Optional enrollment linkage. Miss is a warning (the event
    // still imports as a standalone row). Mismatches between the
    // event's own service/room and the enrollment's surface as
    // warnings too — both are likely admin typos but neither is
    // catastrophic since the event still gets created.
    let enrollmentId: string | null = null;
    if (enrollmentRef.value) {
      const enr = await resolveEnrollment(enrollmentRef.value, ctx);
      if (!enr) {
        warnings.push(
          `Inscription "${enrollmentRef.value}" introuvable — événement créé sans liaison.`,
        );
      } else {
        enrollmentId = enr.id;
        if (serviceId && enr.serviceId !== serviceId) {
          warnings.push(
            `La prestation de l'événement diffère de celle de l'inscription liée.`,
          );
        }
        if (roomId && enr.roomId !== roomId) {
          warnings.push(
            `La salle de l'événement diffère de celle de l'inscription liée.`,
          );
        }
      }
    }

    // Room conflict detection — runs only when we have a valid
    // (roomId, start, end). Conflicts surface as warnings so the admin
    // can confirm in the modal; they don't block the row because
    // sometimes overwriting is intentional (importing a new schedule
    // over an old one in the same room).
    if (roomId && start && end && errors.length === 0) {
      const conflicts = await detectConflicts(ctx, roomId, start, end);
      conflicts.forEach((c) => {
        warnings.push(
          `Conflit de salle : un autre événement occupe déjà ${formatTimeLabel(
            c.startTime,
          )}–${formatTimeLabel(c.endTime)} dans cette salle.`,
        );
      });
    }

    if (errors.length > 0) return { errors, warnings };
    return {
      warnings: warnings.length > 0 ? warnings : undefined,
      data: {
        startTime: start!,
        endTime: end!,
        color: color.value ?? DEFAULT_EVENT_COLOR,
        price: price.value ?? serviceDefaultPrice ?? 0,
        notes: notes.value,
        serviceId,
        serviceCategoryId,
        roomId,
        locationId,
        enrollmentId,
        facilitatorIds: facResolved.ids,
        clientIds: clientResolved.ids,
        tagIds: tagResolved.ids,
        // null on both = standalone event, the default path.
        frequency: frequency.value ?? null,
        recurrenceEndDate: recurrenceBoundary,
        recurrenceOccurrences: occurrences,
      },
    };
  },

  async upsert(data, ctx) {
    // Natural key for upsert: (organizationId, startTime, roomId).
    // No @@unique in schema, so we hand-roll the lookup. This means
    // re-importing the same CSV after a tweak updates the row instead
    // of duplicating.
    const existing = await ctx.prisma.scheduledEvent.findFirst({
      where: {
        organizationId: ctx.organizationId,
        startTime: data.startTime as Date,
        roomId: data.roomId as string,
        deletedAt: null,
      },
      select: { id: true, seriesId: true },
    });

    const facIds = data.facilitatorIds as string[];
    const cliIds = data.clientIds as string[];
    const tagIds = data.tagIds as string[];

    const m2mUpdate = {
      facilitators: { set: facIds.map((id) => ({ id })) },
      clients: { set: cliIds.map((id) => ({ id })) },
      tags: { set: tagIds.map((id) => ({ id })) },
    };
    const m2mCreate = {
      ...(facIds.length > 0
        ? { facilitators: { connect: facIds.map((id) => ({ id })) } }
        : {}),
      ...(cliIds.length > 0
        ? { clients: { connect: cliIds.map((id) => ({ id })) } }
        : {}),
      ...(tagIds.length > 0
        ? { tags: { connect: tagIds.map((id) => ({ id })) } }
        : {}),
    };

    const scalars = {
      startTime: data.startTime as Date,
      endTime: data.endTime as Date,
      color: data.color as string,
      price: data.price as number,
      notes: data.notes as string | null,
      roomId: data.roomId as string,
      locationId: data.locationId as string,
      serviceId: data.serviceId as string,
      serviceCategoryId: data.serviceCategoryId as string,
      // null lets the admin clear a stale linkage by emptying the
      // cell + re-importing. Not in the schema-required set.
      enrollmentId: (data.enrollmentId as string | null) ?? null,
    };

    const occurrences = data.recurrenceOccurrences as Occurrence[] | null;

    // ── Standalone event (no recurrence columns) ────────────────
    if (!occurrences) {
      if (existing) {
        await ctx.prisma.scheduledEvent.update({
          where: { id: existing.id },
          data: { ...scalars, ...m2mUpdate },
        });
        return { id: existing.id, action: 'updated' };
      }
      const created = await ctx.prisma.scheduledEvent.create({
        data: {
          organizationId: ctx.organizationId,
          ...scalars,
          ...m2mCreate,
        },
        select: { id: true },
      });
      return { id: created.id, action: 'created' };
    }

    // ── Recurring series ────────────────────────────────────────
    // The row's natural key (startTime, room) is by construction the
    // series' FIRST occurrence, so it identifies the series on
    // re-import too: find the event at that slot, read its seriesId,
    // and reuse it. That's what stops a second run from creating a
    // parallel series alongside the first.
    const seriesDefaults = {
      frequency: data.frequency as string,
      startDate: data.startTime as Date,
      endDate: data.recurrenceEndDate as Date,
      defaultColor: scalars.color,
      defaultPrice: scalars.price,
      defaultNotes: scalars.notes,
      defaultRoomId: scalars.roomId,
      defaultLocationId: scalars.locationId,
      defaultServiceId: scalars.serviceId,
    };

    let seriesId = existing?.seriesId ?? null;
    if (seriesId) {
      await ctx.prisma.recurrenceSeries.update({
        where: { id: seriesId },
        data: seriesDefaults,
      });
    } else {
      const series = await ctx.prisma.recurrenceSeries.create({
        data: { organizationId: ctx.organizationId, ...seriesDefaults },
        select: { id: true },
      });
      seriesId = series.id;
    }

    // Each occurrence upserts on the same (startTime, room) key the
    // standalone path uses, so re-running lands on the existing rows.
    //
    // Occurrences of a PREVIOUS run that fall outside the new range are
    // left alone rather than deleted — the import is additive
    // everywhere else, and silently destroying calendar rows the admin
    // can't see in the preview would be the wrong trade. Shortening a
    // series is a calendar-side operation.
    for (const occ of occurrences) {
      const occExisting = await ctx.prisma.scheduledEvent.findFirst({
        where: {
          organizationId: ctx.organizationId,
          startTime: occ.startTime,
          roomId: scalars.roomId,
          deletedAt: null,
        },
        select: { id: true },
      });
      const occScalars = {
        ...scalars,
        startTime: occ.startTime,
        endTime: occ.endTime,
        seriesId,
      };
      if (occExisting) {
        await ctx.prisma.scheduledEvent.update({
          where: { id: occExisting.id },
          data: { ...occScalars, ...m2mUpdate },
        });
      } else {
        await ctx.prisma.scheduledEvent.create({
          data: {
            organizationId: ctx.organizationId,
            ...occScalars,
            ...m2mCreate,
          },
          select: { id: true },
        });
      }
    }

    // One CSV row = one series, so the import counters report a single
    // created/updated regardless of how many occurrences it expanded to.
    return { id: seriesId, action: existing ? 'updated' : 'created' };
  },

  async exportRows(ctx) {
    // Bound the export window to "now - 30d" through "now + 90d" by
    // default; importing year-old archived events isn't the typical
    // workflow and the export would otherwise return huge payloads
    // for established schools.
    const now = new Date();
    const from = new Date(now);
    from.setDate(from.getDate() - 30);
    const to = new Date(now);
    to.setDate(to.getDate() + 90);

    const rows = await ctx.prisma.scheduledEvent.findMany({
      where: {
        organizationId: ctx.organizationId,
        deletedAt: null,
        archivedAt: null,
        startTime: { gte: from, lte: to },
      },
      orderBy: { startTime: 'asc' },
      select: {
        startTime: true,
        endTime: true,
        color: true,
        price: true,
        notes: true,
        service: { select: { name: true } },
        room: { select: { name: true } },
        facilitators: { select: { firstname: true, lastname: true, email: true } },
        clients: { select: { email: true } },
        tags: { select: { label: true } },
        // For round-tripping the enrollment composite key on export.
        enrollment: {
          select: {
            client: { select: { email: true } },
            term: { select: { name: true } },
            service: { select: { name: true } },
          },
        },
      },
    });

    const pad = (n: number) => String(n).padStart(2, '0');
    const isoDate = (d: Date) =>
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

    return rows.map(
      (r: {
        startTime: Date;
        endTime: Date;
        color: string;
        price: number;
        notes: string | null;
        service: { name: string } | null;
        room: { name: string } | null;
        facilitators: { firstname: string; lastname: string; email: string }[];
        clients: { email: string }[];
        tags: { label: string }[];
        enrollment: {
          client: { email: string } | null;
          term: { name: string } | null;
          service: { name: string } | null;
        } | null;
      }) => {
        const enrollmentComposite =
          r.enrollment &&
          r.enrollment.client &&
          r.enrollment.term &&
          r.enrollment.service
            ? `${r.enrollment.client.email}|${r.enrollment.term.name}|${r.enrollment.service.name}`
            : '';
        return {
          date: isoDate(r.startTime),
          startTime: hhmm(r.startTime),
          endTime: hhmm(r.endTime),
          service: r.service?.name ?? '',
          room: r.room?.name ?? '',
          // Export by email — round-trips through the import which
          // accepts either email or "Firstname Lastname".
          facilitators: r.facilitators.map((f) => f.email).join(', '),
          clients: r.clients.map((c) => c.email).join(', '),
          color: r.color,
          price: String(r.price),
          notes: r.notes ?? '',
          tags: r.tags.map((t) => t.label).join(', '),
          enrollment: enrollmentComposite,
          // Deliberately blank, even for rows that belong to a series.
          // The export lists MATERIALIZED occurrences — one line per
          // event that already exists. Emitting the series' rule on
          // each of them would make a re-import treat every occurrence
          // as the head of its own new series and re-expand it, turning
          // a 20-event series into 400 events. Blank keeps the existing
          // round-trip contract: each line updates its own row in place
          // and the series linkage (seriesId, not written here) is left
          // untouched.
          frequency: '',
          recurrenceEndDate: '',
        };
      },
    );
  },
};

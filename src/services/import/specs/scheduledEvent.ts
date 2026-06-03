// ScheduledEvent import spec.
//
// One CSV row = one concrete event. No recurrence — admins use the
// calendar form for recurring series; the import is for bulk-loading
// pre-materialized occurrences (e.g. a term schedule exported from
// another tool, or an export from this app that's been edited).
//
// Schema requires 4 FKs: room, location, service, serviceCategory.
// We derive `location` from the Room and `serviceCategory` from the
// Service — admins only supply room + service in the CSV. This
// matches what ScheduledEventService.create() does for the calendar
// form and prevents inconsistencies between hand-typed FKs.
//
// Natural key for upsert: (organizationId, date, startTime, roomId)
// — there's no @@unique in the schema, but this composite is what
// "the same calendar slot" means functionally. Re-running the same
// CSV after edits updates the existing row instead of duplicating.

import {
  parseDate,
  parseFloatNumber,
  parseHexColor,
  parseMultiReference,
  parseString,
  parseTime,
} from '../parsers';
import type { ImportContext, ImportEntitySpec } from '../types';

/**
 * Resolve a Service by name → returns { id, serviceCategoryId } so
 * we can pre-fill the derived serviceCategoryId without a second
 * query. Cached so a CSV with 1000 events on 5 services only hits
 * the DB 5 times.
 */
async function resolveServiceForEvent(
  name: string,
  ctx: ImportContext,
): Promise<{ id: string; serviceCategoryId: string } | null> {
  const key = `serviceForEvent:${name.toLowerCase()}`;
  const cached = ctx.referenceCache.get(key);
  if (cached !== undefined) {
    if (cached === null) return null;
    // Lookup the cached id's category. We re-store as a JSON-ish
    // string in the cache to keep ImportContext.referenceCache typed
    // as Map<string, string|null>. Simpler: cache id and category
    // separately under two keys.
    const catKey = `serviceCategoryFor:${cached}`;
    const cachedCat = ctx.referenceCache.get(catKey);
    if (cachedCat) return { id: cached, serviceCategoryId: cachedCat };
    // Cache hit on id but miss on category — fall through to refetch.
  }
  const row = await ctx.prisma.service.findFirst({
    where: { organizationId: ctx.organizationId, name },
    select: { id: true, serviceCategoryId: true },
  });
  if (!row) {
    ctx.referenceCache.set(key, null);
    return null;
  }
  ctx.referenceCache.set(key, row.id);
  ctx.referenceCache.set(`serviceCategoryFor:${row.id}`, row.serviceCategoryId);
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
      required: true,
      type: 'string',
      description: 'Format HH:MM (24h). Doit être après startTime.',
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
      required: true,
      type: 'string',
      description: 'Couleur hex (#abc ou #aabbcc) — affichage sur le planning.',
      example: '#5b5bff',
    },
    {
      key: 'price',
      label: 'Tarif (€)',
      required: true,
      type: 'number',
      description: 'Décimales avec . ou ,',
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
    const endTime = parseTime(row.endTime, {
      required: true,
      label: 'Heure de fin',
    });
    if (endTime.error) errors.push(endTime.error);

    let start: Date | null = null;
    let end: Date | null = null;
    if (date.value && startTime.value && endTime.value) {
      start = combineDateAndTime(date.value, startTime.value);
      end = combineDateAndTime(date.value, endTime.value);
      if (end.getTime() <= start.getTime()) {
        errors.push("L'heure de fin doit être strictement après l'heure de début");
      }
    }

    const serviceName = parseString(row.service, {
      required: true,
      label: 'Prestation',
    });
    if (serviceName.error) errors.push(serviceName.error);
    const roomName = parseString(row.room, { required: true, label: 'Salle' });
    if (roomName.error) errors.push(roomName.error);

    const color = parseHexColor(row.color, {
      required: true,
      label: 'Couleur',
    });
    if (color.error) errors.push(color.error);
    const price = parseFloatNumber(row.price, {
      required: true,
      label: 'Tarif',
      min: 0,
    });
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
    if (serviceName.value) {
      const svc = await resolveServiceForEvent(serviceName.value, ctx);
      if (!svc) {
        errors.push(`Prestation "${serviceName.value}" introuvable.`);
      } else {
        serviceId = svc.id;
        serviceCategoryId = svc.serviceCategoryId;
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
        color: color.value!,
        price: price.value!,
        notes: notes.value,
        serviceId,
        serviceCategoryId,
        roomId,
        locationId,
        enrollmentId,
        facilitatorIds: facResolved.ids,
        clientIds: clientResolved.ids,
        tagIds: tagResolved.ids,
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
      select: { id: true },
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
        };
      },
    );
  },
};

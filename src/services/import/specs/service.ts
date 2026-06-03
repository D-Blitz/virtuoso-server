// Service import spec.
//
// Required relation: Service → ServiceCategory (by name).
// M2M relations (Tags, Facilitators) skipped in v1.

import {
  parseEnum,
  parseFloatNumber,
  parseInteger,
  parseJson,
  parseMultiReference,
  parseString,
} from '../parsers';
import type { ImportContext, ImportEntitySpec } from '../types';

async function resolveByNames(
  table: 'tag' | 'facilitator',
  names: string[],
  ctx: ImportContext,
): Promise<{ ids: string[]; missing: string[] }> {
  if (names.length === 0) return { ids: [], missing: [] };
  const ids: string[] = [];
  const missing: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (name.length === 0) continue;
    const cacheKey = `${table}:${name.toLowerCase()}`;
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
    if (table === 'tag') {
      row = await ctx.prisma.tag.findFirst({
        where: { organizationId: ctx.organizationId, label: name },
        select: { id: true },
      });
    } else if (table === 'facilitator') {
      // Facilitator natural key is email — but admins reference them
      // by name in CSVs. Accept "firstname lastname" with a space
      // collapsing; fall back to email if the string contains an @.
      const isEmail = name.includes('@');
      if (isEmail) {
        row = await ctx.prisma.facilitator.findFirst({
          where: { organizationId: ctx.organizationId, email: name },
          select: { id: true },
        });
      } else {
        const parts = name.split(/\s+/);
        const firstname = parts[0] ?? '';
        const lastname = parts.slice(1).join(' ');
        if (lastname.length === 0) {
          row = await ctx.prisma.facilitator.findFirst({
            where: { organizationId: ctx.organizationId, firstname },
            select: { id: true },
          });
        } else {
          row = await ctx.prisma.facilitator.findFirst({
            where: {
              organizationId: ctx.organizationId,
              firstname,
              lastname,
            },
            select: { id: true },
          });
        }
      }
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

async function resolveServiceCategoryId(
  name: string,
  ctx: ImportContext,
): Promise<string | null> {
  const key = `serviceCategory:${name.toLowerCase()}`;
  const cached = ctx.referenceCache.get(key);
  if (cached !== undefined) return cached;
  const row = await ctx.prisma.serviceCategory.findFirst({
    where: { organizationId: ctx.organizationId, name },
    select: { id: true },
  });
  const id = row?.id ?? null;
  ctx.referenceCache.set(key, id);
  return id;
}

const BOOKING_MODES = ['LESSON', 'ONE_OFF'] as const;

export const serviceSpec: ImportEntitySpec = {
  type: 'service',
  label: 'Prestations',
  description:
    'Cours, stages, événements. Importez d’abord les catégories avant les prestations.',
  uniqueBy: 'name',
  columns: [
    {
      key: 'name',
      label: 'Nom',
      required: true,
      type: 'string',
      example: 'Cours individuel piano débutant',
    },
    {
      key: 'description',
      label: 'Description',
      required: true,
      type: 'string',
      example: 'Cours de 30 min, niveau débutant',
    },
    {
      key: 'category',
      label: 'Catégorie',
      required: true,
      type: 'reference',
      referenceEntity: 'serviceCategory',
      referenceColumn: 'name',
      description: 'Nom exact de la catégorie — doit déjà exister.',
      example: 'Piano',
    },
    {
      key: 'defaultDurationMinutes',
      label: 'Durée (min)',
      required: true,
      type: 'integer',
      example: '30',
    },
    {
      key: 'defaultPrice',
      label: 'Tarif (€)',
      required: true,
      type: 'number',
      description: 'Décimales avec . ou ,',
      example: '35.00',
    },
    {
      key: 'bookingMode',
      label: 'Mode de réservation',
      required: false,
      type: 'enum',
      enumValues: BOOKING_MODES.slice(),
      description: 'LESSON (trimestre) ou ONE_OFF (achat direct) — défaut LESSON.',
      example: 'LESSON',
    },
    {
      key: 'notes',
      label: 'Notes',
      required: false,
      type: 'string',
    },
    {
      key: 'metadata',
      label: 'Métadonnées (JSON)',
      required: false,
      type: 'json',
      description: 'Objet JSON libre pour vos propres champs.',
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
      key: 'facilitators',
      label: 'Intervenants',
      required: false,
      type: 'multiReference',
      referenceEntity: 'facilitator',
      referenceColumn: 'name',
      description:
        'Noms (« Prénom Nom ») ou emails d’intervenants séparés par des virgules.',
    },
  ],
  async parseRow(row, ctx) {
    const errors: string[] = [];
    // M2M misses (tags, facilitators) are warnings — they don't
    // block the row. ServiceCategory miss IS an error because
    // serviceCategoryId is required.
    const warnings: string[] = [];
    const name = parseString(row.name, { required: true, label: 'Nom' });
    if (name.error) errors.push(name.error);
    const description = parseString(row.description, {
      required: true,
      label: 'Description',
    });
    if (description.error) errors.push(description.error);
    const categoryName = parseString(row.category, {
      required: true,
      label: 'Catégorie',
    });
    if (categoryName.error) errors.push(categoryName.error);
    const duration = parseInteger(row.defaultDurationMinutes, {
      required: true,
      label: 'Durée',
      min: 1,
      max: 24 * 60,
    });
    if (duration.error) errors.push(duration.error);
    const price = parseFloatNumber(row.defaultPrice, {
      required: true,
      label: 'Tarif',
      min: 0,
    });
    if (price.error) errors.push(price.error);
    const bookingMode = parseEnum(row.bookingMode, BOOKING_MODES, {
      label: 'Mode de réservation',
      default: 'LESSON',
    });
    if (bookingMode.error) errors.push(bookingMode.error);
    const notes = parseString(row.notes);
    if (notes.error) errors.push(notes.error);
    const metadata = parseJson(row.metadata, { label: 'Métadonnées' });
    if (metadata.error) errors.push(metadata.error);

    const tagNames = parseMultiReference(row.tags, { label: 'Étiquettes' });
    if (tagNames.error) errors.push(tagNames.error);
    const facNames = parseMultiReference(row.facilitators, {
      label: 'Intervenants',
    });
    if (facNames.error) errors.push(facNames.error);
    const tagResolved = await resolveByNames('tag', tagNames.value ?? [], ctx);
    tagResolved.missing.forEach((n) =>
      warnings.push(
        `Étiquette "${n}" introuvable — relation ignorée pour cette ligne.`,
      ),
    );
    const facResolved = await resolveByNames(
      'facilitator',
      facNames.value ?? [],
      ctx,
    );
    facResolved.missing.forEach((n) =>
      warnings.push(
        `Intervenant "${n}" introuvable — relation ignorée pour cette ligne.`,
      ),
    );

    let serviceCategoryId: string | null = null;
    if (categoryName.value) {
      serviceCategoryId = await resolveServiceCategoryId(
        categoryName.value,
        ctx,
      );
      if (!serviceCategoryId) {
        errors.push(
          `Catégorie "${categoryName.value}" introuvable dans votre organisation.`,
        );
      }
    }
    if (errors.length > 0) return { errors, warnings };
    return {
      warnings: warnings.length > 0 ? warnings : undefined,
      data: {
        name: name.value!,
        description: description.value!,
        serviceCategoryId,
        defaultDurationMinutes: duration.value!,
        defaultPrice: price.value!,
        bookingMode: bookingMode.value ?? 'LESSON',
        notes: notes.value,
        metadata: metadata.value,
        tagIds: tagResolved.ids,
        facilitatorIds: facResolved.ids,
      },
    };
  },
  async upsert(data, ctx) {
    // Prisma m2m: `set` is update-only; create needs `connect` (and
    // we omit empty `connect` lists since they're a no-op).
    const tagIds = data.tagIds as string[];
    const facIds = data.facilitatorIds as string[];
    const m2mUpdate = {
      tags: { set: tagIds.map((id) => ({ id })) },
      facilitators: { set: facIds.map((id) => ({ id })) },
    };
    const m2mCreate = {
      ...(tagIds.length > 0
        ? { tags: { connect: tagIds.map((id) => ({ id })) } }
        : {}),
      ...(facIds.length > 0
        ? { facilitators: { connect: facIds.map((id) => ({ id })) } }
        : {}),
    };
    const scalars = {
      description: data.description as string,
      serviceCategoryId: data.serviceCategoryId as string,
      defaultDurationMinutes: data.defaultDurationMinutes as number,
      defaultPrice: data.defaultPrice as number,
      bookingMode: data.bookingMode as string,
      notes: data.notes as string | null,
      ...(data.metadata != null ? { metadata: data.metadata as object } : {}),
    };
    const existing = await ctx.prisma.service.findFirst({
      where: { organizationId: ctx.organizationId, name: data.name as string },
      select: { id: true },
    });
    if (existing) {
      await ctx.prisma.service.update({
        where: { id: existing.id },
        data: { ...scalars, ...m2mUpdate },
      });
      return { id: existing.id, action: 'updated' };
    }
    const created = await ctx.prisma.service.create({
      data: {
        organizationId: ctx.organizationId,
        name: data.name as string,
        ...scalars,
        ...m2mCreate,
      },
      select: { id: true },
    });
    return { id: created.id, action: 'created' };
  },
  async exportRows(ctx) {
    const rows = await ctx.prisma.service.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { name: 'asc' },
      select: {
        name: true,
        description: true,
        defaultDurationMinutes: true,
        defaultPrice: true,
        bookingMode: true,
        notes: true,
        metadata: true,
        serviceCategory: { select: { name: true } },
        tags: { select: { label: true } },
        facilitators: { select: { firstname: true, lastname: true } },
      },
    });
    return rows.map(
      (r: {
        name: string;
        description: string;
        defaultDurationMinutes: number;
        defaultPrice: number;
        bookingMode: string;
        notes: string | null;
        metadata: unknown;
        serviceCategory: { name: string } | null;
        tags: { label: string }[];
        facilitators: { firstname: string; lastname: string }[];
      }) => ({
        name: r.name,
        description: r.description,
        category: r.serviceCategory?.name ?? '',
        defaultDurationMinutes: String(r.defaultDurationMinutes),
        defaultPrice: String(r.defaultPrice),
        bookingMode: r.bookingMode,
        notes: r.notes ?? '',
        metadata: r.metadata == null ? '' : JSON.stringify(r.metadata),
        tags: r.tags.map((t) => t.label).join(', '),
        facilitators: r.facilitators
          .map((f) => `${f.firstname} ${f.lastname}`.trim())
          .join(', '),
      }),
    );
  },
};

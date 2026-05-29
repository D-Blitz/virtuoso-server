// Service import spec.
//
// Required relation: Service → ServiceCategory (by name).
// M2M relations (Tags, Facilitators) skipped in v1.

import {
  parseEnum,
  parseFloatNumber,
  parseInteger,
  parseString,
} from '../parsers';
import type { ImportContext, ImportEntitySpec } from '../types';

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
  ],
  async parseRow(row, ctx) {
    const errors: string[] = [];
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
    if (errors.length > 0) return { errors };
    return {
      data: {
        name: name.value!,
        description: description.value!,
        serviceCategoryId,
        defaultDurationMinutes: duration.value!,
        defaultPrice: price.value!,
        bookingMode: bookingMode.value ?? 'LESSON',
        notes: notes.value,
      },
    };
  },
  async upsert(data, ctx) {
    const existing = await ctx.prisma.service.findFirst({
      where: { organizationId: ctx.organizationId, name: data.name as string },
      select: { id: true },
    });
    if (existing) {
      await ctx.prisma.service.update({
        where: { id: existing.id },
        data: {
          description: data.description as string,
          serviceCategoryId: data.serviceCategoryId as string,
          defaultDurationMinutes: data.defaultDurationMinutes as number,
          defaultPrice: data.defaultPrice as number,
          bookingMode: data.bookingMode as string,
          notes: data.notes as string | null,
        },
      });
      return { id: existing.id, action: 'updated' };
    }
    const created = await ctx.prisma.service.create({
      data: {
        organizationId: ctx.organizationId,
        name: data.name as string,
        description: data.description as string,
        serviceCategoryId: data.serviceCategoryId as string,
        defaultDurationMinutes: data.defaultDurationMinutes as number,
        defaultPrice: data.defaultPrice as number,
        bookingMode: data.bookingMode as string,
        notes: data.notes as string | null,
      },
      select: { id: true },
    });
    return { id: created.id, action: 'created' };
  },
};

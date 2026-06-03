// Term import spec (Période / Trimestre).
//
// Optional relation: Term → Location. Empty cell = no location
// scoping (term applies org-wide).

import { parseDate, parseString } from '../parsers';
import type { ImportContext, ImportEntitySpec } from '../types';

async function resolveLocationId(
  name: string,
  ctx: ImportContext,
): Promise<string | null> {
  const key = `location:${name.toLowerCase()}`;
  const cached = ctx.referenceCache.get(key);
  if (cached !== undefined) return cached;
  const row = await ctx.prisma.location.findFirst({
    where: { organizationId: ctx.organizationId, name },
    select: { id: true },
  });
  const id = row?.id ?? null;
  ctx.referenceCache.set(key, id);
  return id;
}

export const termSpec: ImportEntitySpec = {
  type: 'term',
  label: 'Périodes',
  description:
    'Trimestres / périodes de facturation. Peuvent être limitées à un lieu (laissez la colonne vide pour appliquer à toute l’organisation).',
  uniqueBy: 'name',
  columns: [
    {
      key: 'name',
      label: 'Nom',
      required: true,
      type: 'string',
      example: 'Trimestre 1 — 2026/2027',
    },
    {
      key: 'startDate',
      label: 'Date de début',
      required: true,
      type: 'date',
      description: 'Format ISO yyyy-mm-dd.',
      example: '2026-09-01',
    },
    {
      key: 'endDate',
      label: 'Date de fin',
      required: true,
      type: 'date',
      example: '2026-12-19',
    },
    {
      key: 'location',
      label: 'Lieu (optionnel)',
      required: false,
      type: 'reference',
      referenceEntity: 'location',
      referenceColumn: 'name',
      description: 'Nom exact du lieu — laissez vide pour appliquer à toute l’organisation.',
    },
  ],
  async parseRow(row, ctx) {
    const errors: string[] = [];
    // Term.locationId is OPTIONAL → missing location is a warning,
    // not an error. The term is created org-wide; a later re-import
    // after creating the location will scope it correctly.
    const warnings: string[] = [];
    const name = parseString(row.name, { required: true, label: 'Nom' });
    if (name.error) errors.push(name.error);
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
    const locationName = parseString(row.location);
    if (locationName.error) errors.push(locationName.error);
    let locationId: string | null = null;
    if (locationName.value) {
      locationId = await resolveLocationId(locationName.value, ctx);
      if (!locationId) {
        warnings.push(
          `Lieu "${locationName.value}" introuvable — période créée sans rattachement à un lieu.`,
        );
      }
    }
    if (errors.length > 0) return { errors, warnings };
    return {
      warnings: warnings.length > 0 ? warnings : undefined,
      data: {
        name: name.value!,
        startDate: startDate.value!,
        endDate: endDate.value!,
        locationId,
      },
    };
  },
  async upsert(data, ctx) {
    const existing = await ctx.prisma.term.findFirst({
      where: { organizationId: ctx.organizationId, name: data.name as string },
      select: { id: true },
    });
    if (existing) {
      await ctx.prisma.term.update({
        where: { id: existing.id },
        data: {
          startDate: data.startDate as Date,
          endDate: data.endDate as Date,
          locationId: data.locationId as string | null,
        },
      });
      return { id: existing.id, action: 'updated' };
    }
    const created = await ctx.prisma.term.create({
      data: {
        organizationId: ctx.organizationId,
        name: data.name as string,
        startDate: data.startDate as Date,
        endDate: data.endDate as Date,
        locationId: data.locationId as string | null,
      },
      select: { id: true },
    });
    return { id: created.id, action: 'created' };
  },
  async exportRows(ctx) {
    const rows = await ctx.prisma.term.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { startDate: 'asc' },
      select: {
        name: true,
        startDate: true,
        endDate: true,
        location: { select: { name: true } },
      },
    });
    return rows.map(
      (r: {
        name: string;
        startDate: Date;
        endDate: Date;
        location: { name: string } | null;
      }) => ({
        name: r.name,
        startDate: r.startDate.toISOString().slice(0, 10),
        endDate: r.endDate.toISOString().slice(0, 10),
        location: r.location?.name ?? '',
      }),
    );
  },
};

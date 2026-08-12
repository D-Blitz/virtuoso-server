// Room import spec.
//
// Required relation: Room → Location. We resolve the location by
// matching the CSV's `location` cell against the existing Location.name
// within the same organization. Empty cell = error (relation is
// required).

import { Prisma } from '@prisma/client';

import { parseHexColor, parseJson, parseString } from '../parsers';
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

export const roomSpec: ImportEntitySpec = {
  type: 'room',
  label: 'Salles',
  description:
    'Espaces réservables dans un lieu. Importez d’abord les lieux avant les salles.',
  uniqueBy: 'name',
  columns: [
    {
      key: 'name',
      label: 'Nom',
      required: true,
      type: 'string',
      example: 'Salle Mozart',
    },
    {
      key: 'location',
      label: 'Lieu',
      required: true,
      type: 'reference',
      referenceEntity: 'location',
      referenceColumn: 'name',
      description: 'Nom exact du lieu — doit déjà exister dans la base.',
      example: 'Studio principal',
    },
    {
      key: 'color',
      label: 'Couleur',
      required: true,
      type: 'string',
      description: 'Couleur hex (#abc ou #aabbcc).',
      example: '#fa8072',
    },
    {
      key: 'notes',
      label: 'Notes',
      required: false,
      type: 'string',
    },
    {
      key: 'availability',
      label: 'Disponibilités (JSON)',
      required: false,
      type: 'json',
      description:
        'Objet JSON : une clé par jour de la semaine (0 = dimanche, 1 = lundi, … 6 = samedi), et pour chaque jour la liste de ses créneaux { "start": "HH:MM", "end": "HH:MM" } en 24h. Plusieurs créneaux par jour sont possibles (matin et après-midi). Laissez vide pour suivre les horaires d’ouverture du lieu — c’est le cas courant. Renseignez-le uniquement pour une salle dont les horaires diffèrent de son lieu ; {} signifie « jamais ouverte ».',
      example:
        '{"1":[{"start":"09:00","end":"12:00"},{"start":"14:00","end":"18:00"}],"3":[{"start":"10:00","end":"13:00"}]}',
    },
    {
      key: 'metadata',
      label: 'Métadonnées (JSON)',
      required: false,
      type: 'json',
    },
  ],
  async parseRow(row, ctx) {
    const errors: string[] = [];
    const name = parseString(row.name, { required: true, label: 'Nom' });
    if (name.error) errors.push(name.error);
    const locationName = parseString(row.location, {
      required: true,
      label: 'Lieu',
    });
    if (locationName.error) errors.push(locationName.error);
    const color = parseHexColor(row.color, {
      required: true,
      label: 'Couleur',
    });
    if (color.error) errors.push(color.error);
    const notes = parseString(row.notes);
    if (notes.error) errors.push(notes.error);
    // Empty cell → null, i.e. "inherit the location's opening hours".
    // parseJson already returns null for an empty cell, so no `default`
    // here; passing {} would make every imported room an explicit
    // "never open" override.
    const availability = parseJson(row.availability, {
      label: 'Disponibilités',
    });
    if (availability.error) errors.push(availability.error);
    const metadata = parseJson(row.metadata, { label: 'Métadonnées' });
    if (metadata.error) errors.push(metadata.error);

    let locationId: string | null = null;
    if (locationName.value) {
      locationId = await resolveLocationId(locationName.value, ctx);
      if (!locationId) {
        errors.push(`Lieu "${locationName.value}" introuvable dans votre organisation.`);
      }
    }
    if (errors.length > 0) return { errors };
    return {
      data: {
        name: name.value!,
        locationId,
        color: color.value!,
        notes: notes.value,
        availability: availability.value,
        metadata: metadata.value,
      },
    };
  },
  async upsert(data, ctx) {
    const scalars = {
      color: data.color as string,
      locationId: data.locationId as string,
      notes: data.notes as string | null,
      // null is meaningful: the room follows its location's hours.
      availability: (data.availability as object | null) ?? Prisma.DbNull,
      ...(data.metadata != null ? { metadata: data.metadata as object } : {}),
    };
    const existing = await ctx.prisma.room.findFirst({
      where: { organizationId: ctx.organizationId, name: data.name as string },
      select: { id: true },
    });
    if (existing) {
      await ctx.prisma.room.update({
        where: { id: existing.id },
        data: scalars,
      });
      return { id: existing.id, action: 'updated' };
    }
    const created = await ctx.prisma.room.create({
      data: {
        organizationId: ctx.organizationId,
        name: data.name as string,
        ...scalars,
      },
      select: { id: true },
    });
    return { id: created.id, action: 'created' };
  },
  async exportRows(ctx) {
    const rows = await ctx.prisma.room.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { name: 'asc' },
      select: {
        name: true,
        color: true,
        notes: true,
        availability: true,
        metadata: true,
        location: { select: { name: true } },
      },
    });
    return rows.map(
      (r: {
        name: string;
        color: string;
        notes: string | null;
        availability: unknown;
        metadata: unknown;
        location: { name: string } | null;
      }) => ({
        name: r.name,
        location: r.location?.name ?? '',
        color: r.color,
        notes: r.notes ?? '',
        // An inheriting room exports as an EMPTY cell, not "{}". Writing
        // "{}" would round-trip a room that follows its venue into an
        // explicit "never open" override on the next import.
        availability:
          r.availability == null ? '' : JSON.stringify(r.availability),
        metadata: r.metadata == null ? '' : JSON.stringify(r.metadata),
      }),
    );
  },
};

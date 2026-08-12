// Location import spec.
//
// No relations. Uniquely identified by `name` within an organization.

import { Prisma } from '@prisma/client';

import { parseJson, parseString } from '../parsers';
import type { ImportEntitySpec } from '../types';

export const locationSpec: ImportEntitySpec = {
  type: 'location',
  label: 'Lieux',
  description:
    'Adresses physiques où ont lieu les cours / événements (site principal, annexe, …).',
  uniqueBy: 'name',
  columns: [
    {
      key: 'name',
      label: 'Nom',
      required: true,
      type: 'string',
      description: 'Nom unique du lieu dans votre organisation.',
      example: 'Studio principal',
    },
    {
      key: 'address',
      label: 'Adresse',
      required: true,
      type: 'string',
      example: '12 rue de la Musique, 75011 Paris',
    },
    {
      key: 'description',
      label: 'Description',
      required: false,
      type: 'string',
      example: 'Salle insonorisée — 80m²',
    },
    {
      key: 'openingHours',
      label: 'Horaires d’ouverture (JSON)',
      required: false,
      type: 'json',
      description:
        'Objet JSON : une clé par jour de la semaine (0 = dimanche, 1 = lundi, … 6 = samedi), et pour chaque jour la liste de ses créneaux { "start": "HH:MM", "end": "HH:MM" } en 24h. Ces horaires s’appliquent à toutes les salles du lieu, sauf à celles qui définissent les leurs.',
      example:
        '{"1":[{"start":"09:00","end":"12:00"},{"start":"14:00","end":"18:00"}],"3":[{"start":"10:00","end":"13:00"}]}',
    },
  ],
  async parseRow(row) {
    const errors: string[] = [];
    const name = parseString(row.name, { required: true, label: 'Nom' });
    if (name.error) errors.push(name.error);
    const address = parseString(row.address, { required: true, label: 'Adresse' });
    if (address.error) errors.push(address.error);
    const description = parseString(row.description);
    if (description.error) errors.push(description.error);
    // Empty cell → null: the venue publishes no hours, and its rooms
    // fall through to "unconstrained".
    const openingHours = parseJson(row.openingHours, {
      label: 'Horaires d’ouverture',
    });
    if (openingHours.error) errors.push(openingHours.error);
    if (errors.length > 0) return { errors };
    return {
      data: {
        name: name.value!,
        address: address.value!,
        description: description.value,
        openingHours: openingHours.value ?? null,
      },
    };
  },
  async upsert(data, ctx) {
    const existing = await ctx.prisma.location.findFirst({
      where: { organizationId: ctx.organizationId, name: data.name as string },
      select: { id: true },
    });
    if (existing) {
      await ctx.prisma.location.update({
        where: { id: existing.id },
        data: {
          address: data.address as string,
          description: data.description as string | null,
          openingHours:
            (data.openingHours as object | null) ?? Prisma.DbNull,
        },
      });
      return { id: existing.id, action: 'updated' };
    }
    const created = await ctx.prisma.location.create({
      data: {
        organizationId: ctx.organizationId,
        name: data.name as string,
        address: data.address as string,
        description: data.description as string | null,
        openingHours: (data.openingHours as object | null) ?? Prisma.DbNull,
      },
      select: { id: true },
    });
    return { id: created.id, action: 'created' };
  },
  async exportRows(ctx) {
    const rows = await ctx.prisma.location.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { name: 'asc' },
      select: {
        name: true,
        address: true,
        description: true,
        openingHours: true,
      },
    });
    return rows.map(
      (r: {
        name: string;
        address: string;
        description: string | null;
        openingHours: unknown;
      }) => ({
        name: r.name,
        address: r.address,
        description: r.description ?? '',
        // Blank when unset, so a re-import doesn't write an empty
        // object over "no hours published".
        openingHours:
          r.openingHours == null ? '' : JSON.stringify(r.openingHours),
      }),
    );
  },
};

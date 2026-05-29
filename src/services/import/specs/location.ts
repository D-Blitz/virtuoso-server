// Location import spec.
//
// No relations. Uniquely identified by `name` within an organization.

import { parseString } from '../parsers';
import type { ImportEntitySpec } from '../types';

export const locationSpec: ImportEntitySpec = {
  type: 'location',
  label: 'Lieux',
  description:
    'Adresses physiques où ont lieu les cours / événements (école, annexe, …).',
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
  ],
  async parseRow(row) {
    const errors: string[] = [];
    const name = parseString(row.name, { required: true, label: 'Nom' });
    if (name.error) errors.push(name.error);
    const address = parseString(row.address, { required: true, label: 'Adresse' });
    if (address.error) errors.push(address.error);
    const description = parseString(row.description);
    if (description.error) errors.push(description.error);
    if (errors.length > 0) return { errors };
    return {
      data: {
        name: name.value!,
        address: address.value!,
        description: description.value,
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
      },
      select: { id: true },
    });
    return { id: created.id, action: 'created' };
  },
  async exportRows(ctx) {
    const rows = await ctx.prisma.location.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { name: 'asc' },
      select: { name: true, address: true, description: true },
    });
    return rows.map((r: { name: string; address: string; description: string | null }) => ({
      name: r.name,
      address: r.address,
      description: r.description ?? '',
    }));
  },
};

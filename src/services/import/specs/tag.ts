// Tag import spec.
//
// No relations imported in v1 (Tag.parentId could chain to another
// tag — skip for now; admins can wire up the tree manually).

import { parseString } from '../parsers';
import type { ImportEntitySpec } from '../types';

export const tagSpec: ImportEntitySpec = {
  type: 'tag',
  label: 'Étiquettes',
  description:
    'Libellés réutilisables (genre musical, niveau, équipement…) attachés aux services / intervenants.',
  uniqueBy: 'label',
  columns: [
    {
      key: 'label',
      label: 'Libellé',
      required: true,
      type: 'string',
      example: 'Piano débutant',
    },
  ],
  async parseRow(row) {
    const errors: string[] = [];
    const label = parseString(row.label, { required: true, label: 'Libellé' });
    if (label.error) errors.push(label.error);
    if (errors.length > 0) return { errors };
    return { data: { label: label.value! } };
  },
  async upsert(data, ctx) {
    const existing = await ctx.prisma.tag.findFirst({
      where: { organizationId: ctx.organizationId, label: data.label as string },
      select: { id: true },
    });
    if (existing) {
      return { id: existing.id, action: 'updated' };
    }
    const created = await ctx.prisma.tag.create({
      data: {
        organizationId: ctx.organizationId,
        label: data.label as string,
      },
      select: { id: true },
    });
    return { id: created.id, action: 'created' };
  },
  async exportRows(ctx) {
    const rows = await ctx.prisma.tag.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { label: 'asc' },
      select: { label: true },
    });
    return rows.map((r: { label: string }) => ({ label: r.label }));
  },
};

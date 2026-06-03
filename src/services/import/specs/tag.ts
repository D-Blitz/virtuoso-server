// Tag import spec.
//
// Self-referential parent relation (Tag.parent) — if you want to
// chain tags into a hierarchy, set the parent column to another
// tag's label. The parent must already exist (import tags top-down
// or run the import twice).

import { parseJson, parseString } from '../parsers';
import type { ImportContext, ImportEntitySpec } from '../types';

async function resolveTagId(
  label: string,
  ctx: ImportContext,
): Promise<string | null> {
  const key = `tag:${label.toLowerCase()}`;
  const cached = ctx.referenceCache.get(key);
  if (cached !== undefined) return cached;
  const row = await ctx.prisma.tag.findFirst({
    where: { organizationId: ctx.organizationId, label },
    select: { id: true },
  });
  const id = row?.id ?? null;
  ctx.referenceCache.set(key, id);
  return id;
}

export const tagSpec: ImportEntitySpec = {
  type: 'tag',
  label: 'Étiquettes',
  description:
    'Libellés réutilisables (genre musical, niveau, équipement…) attachés aux services / intervenants. Peuvent former une arborescence via la colonne « parent ».',
  uniqueBy: 'label',
  columns: [
    {
      key: 'label',
      label: 'Libellé',
      required: true,
      type: 'string',
      example: 'Piano débutant',
    },
    {
      key: 'parent',
      label: 'Parent',
      required: false,
      type: 'reference',
      referenceEntity: 'tag',
      referenceColumn: 'label',
      description:
        'Libellé d’une autre étiquette — laissez vide pour une étiquette racine.',
      example: 'Piano',
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
    // Tag.parentId is optional → missing parent is a warning, not
    // an error. The tag still gets created as a root tag; a later
    // re-import after creating the parent will fix the relation.
    const warnings: string[] = [];
    const label = parseString(row.label, { required: true, label: 'Libellé' });
    if (label.error) errors.push(label.error);
    const parentName = parseString(row.parent);
    const metadata = parseJson(row.metadata, { label: 'Métadonnées' });
    if (metadata.error) errors.push(metadata.error);
    let parentId: string | null = null;
    if (parentName.value) {
      parentId = await resolveTagId(parentName.value, ctx);
      if (!parentId) {
        warnings.push(
          `Étiquette parente "${parentName.value}" introuvable — étiquette créée à la racine.`,
        );
      }
    }
    if (errors.length > 0) return { errors, warnings };
    return {
      warnings: warnings.length > 0 ? warnings : undefined,
      data: {
        label: label.value!,
        parentId,
        metadata: metadata.value,
      },
    };
  },
  async upsert(data, ctx) {
    const existing = await ctx.prisma.tag.findFirst({
      where: { organizationId: ctx.organizationId, label: data.label as string },
      select: { id: true },
    });
    const writeData = {
      parentId: data.parentId as string | null,
      ...(data.metadata != null ? { metadata: data.metadata as object } : {}),
    };
    if (existing) {
      await ctx.prisma.tag.update({
        where: { id: existing.id },
        data: writeData,
      });
      return { id: existing.id, action: 'updated' };
    }
    const created = await ctx.prisma.tag.create({
      data: {
        organizationId: ctx.organizationId,
        label: data.label as string,
        ...writeData,
      },
      select: { id: true },
    });
    return { id: created.id, action: 'created' };
  },
  async exportRows(ctx) {
    const rows = await ctx.prisma.tag.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { label: 'asc' },
      select: {
        label: true,
        metadata: true,
        parentId: true,
      },
    });
    // Build a lookup so we can render parent labels without an extra
    // query per row.
    const byId = new Map<string, string>();
    rows.forEach((r: { label: string; parentId: string | null }) => {
      // The select didn't include id; use a second pass to get it.
    });
    const withIds = await ctx.prisma.tag.findMany({
      where: { organizationId: ctx.organizationId },
      select: { id: true, label: true },
    });
    withIds.forEach((r: { id: string; label: string }) => byId.set(r.id, r.label));
    return rows.map(
      (r: { label: string; metadata: unknown; parentId: string | null }) => ({
        label: r.label,
        parent: r.parentId ? byId.get(r.parentId) ?? '' : '',
        metadata: r.metadata == null ? '' : JSON.stringify(r.metadata),
      }),
    );
  },
};

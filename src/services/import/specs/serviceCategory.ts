// ServiceCategory import spec.
//
// Buckets that group Services together (e.g. "Piano", "Guitare",
// "Stages d'été"). Required by every Service.

import { parseBoolean, parseString } from '../parsers';
import type { ImportEntitySpec } from '../types';

export const serviceCategorySpec: ImportEntitySpec = {
  type: 'serviceCategory',
  label: 'Catégories de prestation',
  description:
    'Regroupements de prestations (instrument, type d’activité…). Chaque prestation doit appartenir à une catégorie.',
  uniqueBy: 'name',
  columns: [
    {
      key: 'name',
      label: 'Nom',
      required: true,
      type: 'string',
      example: 'Piano',
    },
    {
      key: 'description',
      label: 'Description',
      required: false,
      type: 'string',
      example: 'Cours individuels et collectifs',
    },
    {
      key: 'isDisplayed',
      label: 'Affichée publiquement',
      required: false,
      type: 'boolean',
      description: 'oui/non, true/false ou 1/0 — défaut : oui.',
      example: 'oui',
    },
    {
      key: 'isBookable',
      label: 'Réservable',
      required: false,
      type: 'boolean',
      description: 'oui/non, true/false ou 1/0 — défaut : oui.',
      example: 'oui',
    },
  ],
  async parseRow(row) {
    const errors: string[] = [];
    const name = parseString(row.name, { required: true, label: 'Nom' });
    if (name.error) errors.push(name.error);
    const description = parseString(row.description);
    if (description.error) errors.push(description.error);
    const isDisplayed = parseBoolean(row.isDisplayed, {
      label: 'Affichée',
      default: true,
    });
    if (isDisplayed.error) errors.push(isDisplayed.error);
    const isBookable = parseBoolean(row.isBookable, {
      label: 'Réservable',
      default: true,
    });
    if (isBookable.error) errors.push(isBookable.error);
    if (errors.length > 0) return { errors };
    return {
      data: {
        name: name.value!,
        description: description.value ?? '',
        isDisplayed: isDisplayed.value ?? true,
        isBookable: isBookable.value ?? true,
      },
    };
  },
  async upsert(data, ctx) {
    const existing = await ctx.prisma.serviceCategory.findFirst({
      where: { organizationId: ctx.organizationId, name: data.name as string },
      select: { id: true },
    });
    if (existing) {
      await ctx.prisma.serviceCategory.update({
        where: { id: existing.id },
        data: {
          description: data.description as string,
          isDisplayed: data.isDisplayed as boolean,
          isBookable: data.isBookable as boolean,
        },
      });
      return { id: existing.id, action: 'updated' };
    }
    const created = await ctx.prisma.serviceCategory.create({
      data: {
        organizationId: ctx.organizationId,
        name: data.name as string,
        description: data.description as string,
        isDisplayed: data.isDisplayed as boolean,
        isBookable: data.isBookable as boolean,
      },
      select: { id: true },
    });
    return { id: created.id, action: 'created' };
  },
};

// Facilitator import spec.
//
// Teachers / animators. Identified by email. M2M relations
// (Location/Service/Tag) are intentionally skipped in v1 — admins
// wire those up via the UI after import. Adding them is a follow-up.

import {
  parseBoolean,
  parseEmail,
  parseHexColor,
  parseString,
} from '../parsers';
import type { ImportEntitySpec } from '../types';

export const facilitatorSpec: ImportEntitySpec = {
  type: 'facilitator',
  label: 'Intervenants',
  description:
    'Professeurs / animateurs. Les relations (lieux, prestations, tags) sont à associer après import depuis la fiche de l’intervenant.',
  uniqueBy: 'email',
  columns: [
    {
      key: 'firstname',
      label: 'Prénom',
      required: true,
      type: 'string',
      example: 'Jean',
    },
    {
      key: 'lastname',
      label: 'Nom',
      required: true,
      type: 'string',
      example: 'Dupont',
    },
    {
      key: 'email',
      label: 'Email',
      required: true,
      type: 'string',
      description: 'Clé d’unicité — un email = un intervenant.',
      example: 'jean.dupont@example.com',
    },
    {
      key: 'phone',
      label: 'Téléphone',
      required: true,
      type: 'string',
      example: '+33 6 11 22 33 44',
    },
    {
      key: 'color',
      label: 'Couleur',
      required: true,
      type: 'string',
      description: 'Couleur hex (#abc ou #aabbcc) — utilisée sur le planning.',
      example: '#5b5bff',
    },
    {
      key: 'isBookable',
      label: 'Réservable',
      required: false,
      type: 'boolean',
      description: 'oui/non, true/false ou 1/0 — défaut : oui.',
      example: 'oui',
    },
    {
      key: 'isBioDisplayed',
      label: 'Bio affichée',
      required: false,
      type: 'boolean',
      example: 'oui',
    },
    {
      key: 'bio',
      label: 'Biographie',
      required: false,
      type: 'string',
    },
    {
      key: 'address',
      label: 'Adresse',
      required: false,
      type: 'string',
    },
    {
      key: 'notes',
      label: 'Notes',
      required: false,
      type: 'string',
    },
  ],
  async parseRow(row) {
    const errors: string[] = [];
    const firstname = parseString(row.firstname, {
      required: true,
      label: 'Prénom',
    });
    if (firstname.error) errors.push(firstname.error);
    const lastname = parseString(row.lastname, { required: true, label: 'Nom' });
    if (lastname.error) errors.push(lastname.error);
    const email = parseEmail(row.email, { required: true, label: 'Email' });
    if (email.error) errors.push(email.error);
    const phone = parseString(row.phone, {
      required: true,
      label: 'Téléphone',
    });
    if (phone.error) errors.push(phone.error);
    const color = parseHexColor(row.color, {
      required: true,
      label: 'Couleur',
    });
    if (color.error) errors.push(color.error);
    const isBookable = parseBoolean(row.isBookable, {
      label: 'Réservable',
      default: true,
    });
    if (isBookable.error) errors.push(isBookable.error);
    const isBioDisplayed = parseBoolean(row.isBioDisplayed, {
      label: 'Bio affichée',
      default: false,
    });
    if (isBioDisplayed.error) errors.push(isBioDisplayed.error);
    const bio = parseString(row.bio);
    if (bio.error) errors.push(bio.error);
    const address = parseString(row.address);
    if (address.error) errors.push(address.error);
    const notes = parseString(row.notes);
    if (notes.error) errors.push(notes.error);
    if (errors.length > 0) return { errors };
    return {
      data: {
        firstname: firstname.value!,
        lastname: lastname.value!,
        email: email.value!,
        phone: phone.value!,
        color: color.value!,
        isBookable: isBookable.value ?? true,
        isBioDisplayed: isBioDisplayed.value ?? false,
        bio: bio.value,
        address: address.value,
        notes: notes.value,
      },
    };
  },
  async upsert(data, ctx) {
    const existing = await ctx.prisma.facilitator.findFirst({
      where: { organizationId: ctx.organizationId, email: data.email as string },
      select: { id: true },
    });
    if (existing) {
      await ctx.prisma.facilitator.update({
        where: { id: existing.id },
        data: {
          firstname: data.firstname as string,
          lastname: data.lastname as string,
          phone: data.phone as string,
          color: data.color as string,
          isBookable: data.isBookable as boolean,
          isBioDisplayed: data.isBioDisplayed as boolean,
          bio: data.bio as string | null,
          address: data.address as string | null,
          notes: data.notes as string | null,
        },
      });
      return { id: existing.id, action: 'updated' };
    }
    const created = await ctx.prisma.facilitator.create({
      data: {
        organizationId: ctx.organizationId,
        firstname: data.firstname as string,
        lastname: data.lastname as string,
        email: data.email as string,
        phone: data.phone as string,
        color: data.color as string,
        availability: {},
        isBookable: data.isBookable as boolean,
        isBioDisplayed: data.isBioDisplayed as boolean,
        bio: data.bio as string | null,
        address: data.address as string | null,
        notes: data.notes as string | null,
      },
      select: { id: true },
    });
    return { id: created.id, action: 'created' };
  },
};

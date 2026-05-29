// Client import spec.
//
// People who book services. Identified naturally by `email` (the
// upsert key). Birthdate is required by the schema; we accept ISO
// yyyy-mm-dd.

import {
  parseDate,
  parseEmail,
  parseString,
} from '../parsers';
import type { ImportEntitySpec } from '../types';

export const clientSpec: ImportEntitySpec = {
  type: 'client',
  label: 'Clients',
  description: 'Personnes inscrites — élèves ou familles.',
  uniqueBy: 'email',
  columns: [
    {
      key: 'firstname',
      label: 'Prénom',
      required: true,
      type: 'string',
      example: 'Léa',
    },
    {
      key: 'lastname',
      label: 'Nom',
      required: true,
      type: 'string',
      example: 'Durand',
    },
    {
      key: 'email',
      label: 'Email',
      required: true,
      type: 'string',
      description: 'Clé d’unicité — un email = un client.',
      example: 'lea.durand@example.com',
    },
    {
      key: 'phone',
      label: 'Téléphone',
      required: true,
      type: 'string',
      example: '+33 6 12 34 56 78',
    },
    {
      key: 'birthdate',
      label: 'Date de naissance',
      required: true,
      type: 'date',
      description: 'Format ISO yyyy-mm-dd.',
      example: '2010-03-14',
    },
    {
      key: 'address',
      label: 'Adresse',
      required: true,
      type: 'string',
      example: '5 rue du Conservatoire, 75009 Paris',
    },
    {
      key: 'notes',
      label: 'Notes',
      required: false,
      type: 'string',
      example: 'Allergie aux noix',
    },
  ],
  async parseRow(row) {
    const errors: string[] = [];
    const firstname = parseString(row.firstname, {
      required: true,
      label: 'Prénom',
    });
    if (firstname.error) errors.push(firstname.error);
    const lastname = parseString(row.lastname, {
      required: true,
      label: 'Nom',
    });
    if (lastname.error) errors.push(lastname.error);
    const email = parseEmail(row.email, { required: true, label: 'Email' });
    if (email.error) errors.push(email.error);
    const phone = parseString(row.phone, {
      required: true,
      label: 'Téléphone',
    });
    if (phone.error) errors.push(phone.error);
    const birthdate = parseDate(row.birthdate, {
      required: true,
      label: 'Date de naissance',
    });
    if (birthdate.error) errors.push(birthdate.error);
    const address = parseString(row.address, {
      required: true,
      label: 'Adresse',
    });
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
        birthdate: birthdate.value!,
        address: address.value!,
        notes: notes.value,
      },
    };
  },
  async upsert(data, ctx) {
    const existing = await ctx.prisma.client.findFirst({
      where: { organizationId: ctx.organizationId, email: data.email as string },
      select: { id: true },
    });
    if (existing) {
      await ctx.prisma.client.update({
        where: { id: existing.id },
        data: {
          firstname: data.firstname as string,
          lastname: data.lastname as string,
          phone: data.phone as string,
          birthdate: data.birthdate as Date,
          address: data.address as string,
          notes: data.notes as string | null,
        },
      });
      return { id: existing.id, action: 'updated' };
    }
    const created = await ctx.prisma.client.create({
      data: {
        organizationId: ctx.organizationId,
        firstname: data.firstname as string,
        lastname: data.lastname as string,
        email: data.email as string,
        phone: data.phone as string,
        birthdate: data.birthdate as Date,
        address: data.address as string,
        notes: data.notes as string | null,
      },
      select: { id: true },
    });
    return { id: created.id, action: 'created' };
  },
  async exportRows(ctx) {
    const rows = await ctx.prisma.client.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: [{ lastname: 'asc' }, { firstname: 'asc' }],
      select: {
        firstname: true,
        lastname: true,
        email: true,
        phone: true,
        birthdate: true,
        address: true,
        notes: true,
      },
    });
    return rows.map(
      (r: {
        firstname: string;
        lastname: string;
        email: string;
        phone: string;
        birthdate: Date;
        address: string;
        notes: string | null;
      }) => ({
        firstname: r.firstname,
        lastname: r.lastname,
        email: r.email,
        phone: r.phone,
        // ISO yyyy-mm-dd for symmetry with the parser.
        birthdate: r.birthdate.toISOString().slice(0, 10),
        address: r.address,
        notes: r.notes ?? '',
      }),
    );
  },
};

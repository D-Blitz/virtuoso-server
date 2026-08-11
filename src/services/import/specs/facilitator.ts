// Facilitator import spec.
//
// Teachers / animators. Identified by email. Full schema coverage:
// scalars + JSON fields (availability, ageScores, levelScores,
// metadata) + string-array (languages) + three m2m relations
// (locations, tags, services), each handled as a comma-separated
// cell of natural keys.
//
// M2M semantics on upsert: we use Prisma's `set:` so the CSV is
// authoritative — the related list after import matches the cell
// exactly. Empty cell = empty list (disconnects any prior relations).

import {
  parseBoolean,
  parseEmail,
  parseFloatNumber,
  parseHexColor,
  parseJson,
  parseMultiReference,
  parseString,
} from '../parsers';
import type { ImportContext, ImportEntitySpec } from '../types';

async function resolveByNames(
  table: 'location' | 'tag' | 'service',
  names: string[],
  ctx: ImportContext,
): Promise<{ ids: string[]; missing: string[] }> {
  if (names.length === 0) return { ids: [], missing: [] };
  const ids: string[] = [];
  const missing: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (name.length === 0) continue;
    const cacheKey = `${table}:${name.toLowerCase()}`;
    const cached = ctx.referenceCache.get(cacheKey);
    if (cached === null) {
      missing.push(name);
      continue;
    }
    if (cached !== undefined) {
      ids.push(cached);
      continue;
    }
    let row: { id: string } | null = null;
    if (table === 'location') {
      row = await ctx.prisma.location.findFirst({
        where: { organizationId: ctx.organizationId, name },
        select: { id: true },
      });
    } else if (table === 'tag') {
      row = await ctx.prisma.tag.findFirst({
        where: { organizationId: ctx.organizationId, label: name },
        select: { id: true },
      });
    } else if (table === 'service') {
      row = await ctx.prisma.service.findFirst({
        where: { organizationId: ctx.organizationId, name },
        select: { id: true },
      });
    }
    if (row) {
      ctx.referenceCache.set(cacheKey, row.id);
      ids.push(row.id);
    } else {
      ctx.referenceCache.set(cacheKey, null);
      missing.push(name);
    }
  }
  return { ids, missing };
}

export const facilitatorSpec: ImportEntitySpec = {
  type: 'facilitator',
  label: 'Intervenants',
  description:
    'Intervenants. Les relations (lieux, étiquettes, prestations) acceptent une liste séparée par des virgules : les valeurs doivent correspondre à des entités déjà importées.',
  uniqueBy: 'email',
  columns: [
    { key: 'firstname', label: 'Prénom', required: true, type: 'string', example: 'Jean' },
    { key: 'lastname', label: 'Nom', required: true, type: 'string', example: 'Dupont' },
    {
      key: 'email',
      label: 'Email',
      required: true,
      type: 'string',
      description: 'Clé d’unicité — un email = un intervenant.',
      example: 'jean.dupont@example.com',
    },
    { key: 'phone', label: 'Téléphone', required: true, type: 'string', example: '+33 6 11 22 33 44' },
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
      example: 'non',
    },
    { key: 'bio', label: 'Biographie', required: false, type: 'string' },
    { key: 'address', label: 'Adresse', required: false, type: 'string' },
    { key: 'notes', label: 'Notes', required: false, type: 'string' },
    {
      key: 'profilePictureUrl',
      label: 'URL photo de profil',
      required: false,
      type: 'string',
    },
    {
      key: 'priorityWeight',
      label: 'Pondération',
      required: false,
      type: 'number',
      description: 'Poids dans le recommender (défaut : 1.0).',
      example: '1.0',
    },
    {
      key: 'languages',
      label: 'Langues',
      required: false,
      type: 'array',
      description: 'Codes BCP-47 séparés par des virgules (ex : fr-FR, en-US).',
      example: 'fr-FR, en-US',
    },
    {
      key: 'availability',
      label: 'Disponibilités (JSON)',
      required: false,
      type: 'json',
      description:
        'Objet JSON : une clé par jour de la semaine (0 = dimanche, 1 = lundi, … 6 = samedi), et pour chaque jour la liste de ses créneaux { "start": "HH:MM", "end": "HH:MM" } en 24h. Plusieurs créneaux par jour sont possibles (matin et après-midi). Les jours absents sont considérés comme non disponibles. Laisser vide pour conserver la valeur actuelle, ou {} pour aucune disponibilité.',
      example:
        '{"1":[{"start":"09:00","end":"12:00"},{"start":"14:00","end":"18:00"}],"3":[{"start":"10:00","end":"13:00"}]}',
    },
    {
      key: 'ageScores',
      label: 'Scores par âge (JSON)',
      required: false,
      type: 'json',
      description: 'Tableau JSON : [{"min":6,"max":12,"score":2},...]',
    },
    {
      key: 'levelScores',
      label: 'Scores par niveau (JSON)',
      required: false,
      type: 'json',
      description: 'Objet JSON : {"BEGINNER":1,"INTERMEDIATE":2,...}',
    },
    {
      key: 'metadata',
      label: 'Métadonnées (JSON)',
      required: false,
      type: 'json',
      description: 'Objet JSON libre pour vos propres champs.',
    },
    {
      key: 'locations',
      label: 'Lieux',
      required: false,
      type: 'multiReference',
      referenceEntity: 'location',
      referenceColumn: 'name',
      description: 'Noms de lieux séparés par des virgules — doivent déjà exister.',
      example: 'Studio principal, Annexe',
    },
    {
      key: 'tags',
      label: 'Étiquettes',
      required: false,
      type: 'multiReference',
      referenceEntity: 'tag',
      referenceColumn: 'label',
      description: 'Libellés d’étiquettes séparés par des virgules.',
      example: 'piano, débutant',
    },
    {
      key: 'services',
      label: 'Prestations enseignées',
      required: false,
      type: 'multiReference',
      referenceEntity: 'service',
      referenceColumn: 'name',
      description: 'Noms de prestations séparés par des virgules.',
    },
  ],
  async parseRow(row, ctx) {
    const errors: string[] = [];
    const warnings: string[] = [];
    const firstname = parseString(row.firstname, { required: true, label: 'Prénom' });
    if (firstname.error) errors.push(firstname.error);
    const lastname = parseString(row.lastname, { required: true, label: 'Nom' });
    if (lastname.error) errors.push(lastname.error);
    const email = parseEmail(row.email, { required: true, label: 'Email' });
    if (email.error) errors.push(email.error);
    const phone = parseString(row.phone, { required: true, label: 'Téléphone' });
    if (phone.error) errors.push(phone.error);
    const color = parseHexColor(row.color, { required: true, label: 'Couleur' });
    if (color.error) errors.push(color.error);
    const isBookable = parseBoolean(row.isBookable, { label: 'Réservable', default: true });
    if (isBookable.error) errors.push(isBookable.error);
    const isBioDisplayed = parseBoolean(row.isBioDisplayed, { label: 'Bio affichée', default: false });
    if (isBioDisplayed.error) errors.push(isBioDisplayed.error);
    const bio = parseString(row.bio);
    const address = parseString(row.address);
    const notes = parseString(row.notes);
    const profilePictureUrl = parseString(row.profilePictureUrl);
    const priorityWeight = parseFloatNumber(row.priorityWeight, {
      label: 'Pondération',
      min: 0,
    });
    if (priorityWeight.error) errors.push(priorityWeight.error);

    const languagesRaw = parseMultiReference(row.languages, {
      label: 'Langues',
      separator: ',',
    });
    if (languagesRaw.error) errors.push(languagesRaw.error);

    const availability = parseJson(row.availability, {
      label: 'Disponibilités',
      default: {},
    });
    if (availability.error) errors.push(availability.error);
    const ageScores = parseJson(row.ageScores, {
      label: 'Scores par âge',
      default: [],
    });
    if (ageScores.error) errors.push(ageScores.error);
    const levelScores = parseJson(row.levelScores, {
      label: 'Scores par niveau',
      default: {},
    });
    if (levelScores.error) errors.push(levelScores.error);
    const metadata = parseJson(row.metadata, { label: 'Métadonnées' });
    if (metadata.error) errors.push(metadata.error);

    // M2M lookups — fail-soft (we record missing names as row errors
    // rather than letting the upsert blow up with a Prisma foreign-
    // key violation).
    const locNames = parseMultiReference(row.locations, { label: 'Lieux' });
    if (locNames.error) errors.push(locNames.error);
    const tagNames = parseMultiReference(row.tags, { label: 'Étiquettes' });
    if (tagNames.error) errors.push(tagNames.error);
    const svcNames = parseMultiReference(row.services, { label: 'Prestations' });
    if (svcNames.error) errors.push(svcNames.error);

    // Missing m2m targets become WARNINGS — the row still commits
    // with the targets that DID resolve, and Prisma's `set:` semantics
    // mean a later re-import after fixing the missing entries will
    // reattach them correctly. The admin confirms in the UI before
    // the warning rows commit.
    const locResolved = await resolveByNames('location', locNames.value ?? [], ctx);
    locResolved.missing.forEach((n) =>
      warnings.push(
        `Lieu "${n}" introuvable — relation ignorée pour cette ligne.`,
      ),
    );
    const tagResolved = await resolveByNames('tag', tagNames.value ?? [], ctx);
    tagResolved.missing.forEach((n) =>
      warnings.push(
        `Étiquette "${n}" introuvable — relation ignorée pour cette ligne.`,
      ),
    );
    const svcResolved = await resolveByNames('service', svcNames.value ?? [], ctx);
    svcResolved.missing.forEach((n) =>
      warnings.push(
        `Prestation "${n}" introuvable — relation ignorée pour cette ligne.`,
      ),
    );

    if (errors.length > 0) return { errors, warnings };
    return {
      warnings: warnings.length > 0 ? warnings : undefined,
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
        profilePictureUrl: profilePictureUrl.value,
        priorityWeight: priorityWeight.value,
        languages: languagesRaw.value ?? [],
        availability: availability.value,
        ageScores: ageScores.value,
        levelScores: levelScores.value,
        metadata: metadata.value,
        locationIds: locResolved.ids,
        tagIds: tagResolved.ids,
        serviceIds: svcResolved.ids,
      },
    };
  },
  async upsert(data, ctx) {
    // M2M payload differs between create and update on Prisma:
    //   - create accepts `connect` (no rows exist yet to replace)
    //   - update accepts `set` (authoritative replace)
    // We omit relations from create entirely when the list is empty
    // — Prisma rejects `connect: []` in some versions, and an empty
    // create is the same as not mentioning the relation.
    const locIds = data.locationIds as string[];
    const tagIds = data.tagIds as string[];
    const svcIds = data.serviceIds as string[];
    const m2mUpdate = {
      locations: { set: locIds.map((id) => ({ id })) },
      tags: { set: tagIds.map((id) => ({ id })) },
      services: { set: svcIds.map((id) => ({ id })) },
    };
    const m2mCreate = {
      ...(locIds.length > 0
        ? { locations: { connect: locIds.map((id) => ({ id })) } }
        : {}),
      ...(tagIds.length > 0
        ? { tags: { connect: tagIds.map((id) => ({ id })) } }
        : {}),
      ...(svcIds.length > 0
        ? { services: { connect: svcIds.map((id) => ({ id })) } }
        : {}),
    };
    const scalars = {
      firstname: data.firstname as string,
      lastname: data.lastname as string,
      phone: data.phone as string,
      color: data.color as string,
      isBookable: data.isBookable as boolean,
      isBioDisplayed: data.isBioDisplayed as boolean,
      bio: data.bio as string | null,
      address: data.address as string | null,
      notes: data.notes as string | null,
      profilePictureUrl: data.profilePictureUrl as string | null,
      ...(data.priorityWeight != null
        ? { priorityWeight: data.priorityWeight as number }
        : {}),
      languages: data.languages as string[],
      availability: data.availability as object,
      ageScores: data.ageScores as object,
      levelScores: data.levelScores as object,
      ...(data.metadata != null ? { metadata: data.metadata as object } : {}),
    };
    const existing = await ctx.prisma.facilitator.findFirst({
      where: { organizationId: ctx.organizationId, email: data.email as string },
      select: { id: true },
    });
    if (existing) {
      await ctx.prisma.facilitator.update({
        where: { id: existing.id },
        data: { ...scalars, ...m2mUpdate },
      });
      return { id: existing.id, action: 'updated' };
    }
    const created = await ctx.prisma.facilitator.create({
      data: {
        organizationId: ctx.organizationId,
        email: data.email as string,
        ...scalars,
        ...m2mCreate,
      },
      select: { id: true },
    });
    return { id: created.id, action: 'created' };
  },
  async exportRows(ctx) {
    const rows = await ctx.prisma.facilitator.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: [{ lastname: 'asc' }, { firstname: 'asc' }],
      select: {
        firstname: true,
        lastname: true,
        email: true,
        phone: true,
        color: true,
        isBookable: true,
        isBioDisplayed: true,
        bio: true,
        address: true,
        notes: true,
        profilePictureUrl: true,
        priorityWeight: true,
        languages: true,
        availability: true,
        ageScores: true,
        levelScores: true,
        metadata: true,
        locations: { select: { name: true } },
        tags: { select: { label: true } },
        services: { select: { name: true } },
      },
    });
    return rows.map(
      (r: {
        firstname: string;
        lastname: string;
        email: string;
        phone: string;
        color: string;
        isBookable: boolean;
        isBioDisplayed: boolean;
        bio: string | null;
        address: string | null;
        notes: string | null;
        profilePictureUrl: string | null;
        priorityWeight: number;
        languages: string[];
        availability: unknown;
        ageScores: unknown;
        levelScores: unknown;
        metadata: unknown;
        locations: { name: string }[];
        tags: { label: string }[];
        services: { name: string }[];
      }) => ({
        firstname: r.firstname,
        lastname: r.lastname,
        email: r.email,
        phone: r.phone,
        color: r.color,
        isBookable: r.isBookable ? 'oui' : 'non',
        isBioDisplayed: r.isBioDisplayed ? 'oui' : 'non',
        bio: r.bio ?? '',
        address: r.address ?? '',
        notes: r.notes ?? '',
        profilePictureUrl: r.profilePictureUrl ?? '',
        priorityWeight: String(r.priorityWeight),
        languages: r.languages.join(', '),
        availability: JSON.stringify(r.availability ?? {}),
        ageScores: JSON.stringify(r.ageScores ?? []),
        levelScores: JSON.stringify(r.levelScores ?? {}),
        metadata: r.metadata == null ? '' : JSON.stringify(r.metadata),
        locations: r.locations.map((l) => l.name).join(', '),
        tags: r.tags.map((t) => t.label).join(', '),
        services: r.services.map((s) => s.name).join(', '),
      }),
    );
  },
};

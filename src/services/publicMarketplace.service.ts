import prisma from '../prisma';

/**
 * Public, cross-organization marketplace data. Read-only, no auth — these are
 * consumed by the consumer marketplace app (apps/marketplace) via the
 * /api/public/* mount (which bypasses requireUser; see index.ts).
 *
 * DTOs are deliberately PUBLIC-SAFE: facilitators expose name / bio (only if
 * isBioDisplayed) / photo / languages / disciplines / venues — never email,
 * phone, address, notes, scores or availability.
 *
 * NOTE: this currently returns every non-deleted / non-archived venue and
 * every bookable facilitator across ALL organizations. Before launch this
 * should be gated by an explicit "listed on marketplace" opt-in flag
 * (per org / venue / facilitator).
 */

function uniq(values: (string | null | undefined)[]): string[] {
  return Array.from(new Set(values.filter((v): v is string => !!v)));
}

function minOrUndefined(values: number[]): number | undefined {
  return values.length ? Math.min(...values) : undefined;
}

export async function getPublicVenues() {
  const locations = await prisma.location.findMany({
    where: { deletedAt: null, archivedAt: null },
    include: {
      facilitators: {
        where: { deletedAt: null, archivedAt: null, isBookable: true },
        include: { services: { include: { serviceCategory: true } } },
      },
    },
    orderBy: { name: 'asc' },
  });

  return locations.map((loc) => {
    const services = loc.facilitators.flatMap((f) => f.services);
    return {
      id: loc.id,
      name: loc.name,
      address: loc.address,
      description: loc.description ?? undefined,
      photoUrl: loc.photoUrl ?? null,
      latitude: loc.latitude ?? null,
      longitude: loc.longitude ?? null,
      categories: uniq(services.map((s) => s.serviceCategory?.name)),
      teacherCount: loc.facilitators.length,
      fromPrice: minOrUndefined(services.map((s) => s.defaultPrice)),
    };
  });
}

export async function getPublicFacilitators() {
  const facilitators = await prisma.facilitator.findMany({
    where: { deletedAt: null, archivedAt: null, isBookable: true },
    include: {
      locations: { where: { deletedAt: null, archivedAt: null } },
      services: { include: { serviceCategory: true } },
    },
    orderBy: [{ lastname: 'asc' }, { firstname: 'asc' }],
  });

  return facilitators.map((f) => {
    // A facilitator's location for distance = their first venue with coords
    // (independent teachers without a geocoded venue have none).
    const geo = f.locations.find((l) => l.latitude != null && l.longitude != null);
    return {
      id: f.id,
      name: `${f.firstname} ${f.lastname}`.trim(),
      bio: f.isBioDisplayed ? f.bio ?? undefined : undefined,
      photoUrl: f.profilePictureUrl ?? null,
      latitude: geo?.latitude ?? null,
      longitude: geo?.longitude ?? null,
      languages: f.languages ?? [],
      disciplines: uniq(f.services.map((s) => s.serviceCategory?.name)),
      venueNames: f.locations.map((l) => l.name),
      independent: f.locations.length === 0,
      fromPrice: minOrUndefined(f.services.map((s) => s.defaultPrice)),
      modes: [] as string[], // no lesson-mode field on Facilitator yet
    };
  });
}

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

/**
 * Single-venue detail for the marketplace venue page. Adds gallery, the
 * de-duplicated union of the venue's facilitators' services, and the team
 * (public-safe facilitator fields) on top of the basic venue fields.
 *
 * NOTE: opening hours are NOT modelled on Location yet — the marketplace mocks
 * them client-side. Add an `openingHours Json?` to Location to make them real.
 */
export async function getPublicVenueDetail(id: string) {
  const loc = await prisma.location.findFirst({
    where: { id, deletedAt: null, archivedAt: null },
    include: {
      facilitators: {
        where: { deletedAt: null, archivedAt: null, isBookable: true },
        include: {
          services: {
            where: { deletedAt: null, archivedAt: null },
            include: { serviceCategory: true },
          },
        },
      },
    },
  });
  if (!loc) return null;

  // A venue's services = the de-duplicated union of its facilitators' services.
  const seen = new Set<string>();
  const services = [];
  for (const s of loc.facilitators.flatMap((f) => f.services)) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    services.push({
      id: s.id,
      name: s.name,
      description: s.description ?? '',
      durationMinutes: s.defaultDurationMinutes,
      price: s.defaultPrice,
      categoryName: s.serviceCategory?.name ?? 'Autres',
      bookingMode: s.bookingMode,
    });
  }

  // Other venues of the same organization (for the "Autres établissements" row).
  const others = await prisma.location.findMany({
    where: {
      organizationId: loc.organizationId,
      id: { not: loc.id },
      deletedAt: null,
      archivedAt: null,
    },
    include: {
      facilitators: {
        where: { deletedAt: null, archivedAt: null, isBookable: true },
        include: { services: { include: { serviceCategory: true } } },
      },
    },
    orderBy: { name: 'asc' },
  });
  const otherVenues = others.map((o) => {
    const svcs = o.facilitators.flatMap((f) => f.services);
    return {
      id: o.id,
      name: o.name,
      address: o.address,
      photoUrl: o.photoUrl ?? null,
      gallery: o.gallery ?? [],
      latitude: o.latitude ?? null,
      longitude: o.longitude ?? null,
      categories: uniq(svcs.map((s) => s.serviceCategory?.name)),
      teacherCount: o.facilitators.length,
      fromPrice: minOrUndefined(svcs.map((s) => s.defaultPrice)),
    };
  });

  return {
    id: loc.id,
    name: loc.name,
    address: loc.address,
    description: loc.description ?? undefined,
    photoUrl: loc.photoUrl ?? null,
    gallery: loc.gallery ?? [],
    latitude: loc.latitude ?? null,
    longitude: loc.longitude ?? null,
    phone: loc.phone ?? null,
    categories: uniq(services.map((s) => s.categoryName)),
    teacherCount: loc.facilitators.length,
    fromPrice: minOrUndefined(services.map((s) => s.price)),
    services,
    team: loc.facilitators.map((f) => ({
      id: f.id,
      firstName: f.firstname,
      name: `${f.firstname} ${f.lastname}`.trim(),
      photoUrl: f.profilePictureUrl ?? null,
    })),
    otherVenues,
  };
}

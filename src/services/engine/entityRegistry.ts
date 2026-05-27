// Allow-list of entity types that visitor-facing flows can reference
// via the ENTITY_REF form field (Phase 3.4).
//
// Why an explicit registry instead of "any Prisma model":
//   - Public, unauthenticated endpoints serve the entity list — every
//     surfaced model has to be reviewed against "is it safe to expose
//     a list of these to anyone on the internet?".
//   - The set of fields a visitor can see + extract is curated per
//     entity. Showing a facilitator's bio is fine; showing their
//     home address is not.
//   - Filtering knobs (e.g. only bookable rooms, only facilitators in
//     a given location) are kind-specific and easier to whitelist than
//     to leak via raw Prisma `where` from the client.
//
// Adding a new entity type = adding one descriptor here + matching
// type widening in the field-config validation.

import prisma from '../../prisma';

export type EntityType = 'facilitator' | 'room' | 'client' | 'service';

/**
 * Public-safe projection of a resolved entity.
 *   - `id` is always the canonical Prisma id.
 *   - `label` is the display string the renderer shows in the picker.
 *   - `fields` are the safe extractable fields requested by the flow.
 *     Only fields in the descriptor's `safeFields` list can land here.
 */
export type ResolvedEntity = {
  id: string;
  label: string;
  fields: Record<string, unknown>;
};

type ListOptions = {
  organizationId: string;
  /**
   * Limit on the number of returned rows. The endpoint enforces a
   * server-side max so a flow author can't request thousands.
   */
  limit?: number;
};

type ResolveOptions = {
  organizationId: string;
  id: string;
  /** Subset of safeFields the flow asked to extract for downstream vars. */
  extractFields?: string[];
};

type EntityDescriptor = {
  type: EntityType;
  /** Plain-French label for the admin's kind picker. */
  label: string;
  /**
   * Whitelist of fields any flow can request via `extractFields`. Any
   * value outside this set is silently dropped at resolve time — the
   * server is the gatekeeper for what's safe.
   */
  safeFields: string[];
  /**
   * Server-side max for `limit` on the list endpoint. Keeps pagination
   * honest; visitors shouldn't be able to pull 50k records.
   */
  maxListSize: number;
  /** Fetch a paginated list, scoped to the org. */
  list(opts: ListOptions): Promise<ResolvedEntity[]>;
  /** Fetch one + project the requested safe fields. */
  resolve(opts: ResolveOptions): Promise<ResolvedEntity | null>;
};

// ─── Helpers ──────────────────────────────────────────────────────

function pickSafe(
  row: Record<string, unknown>,
  safeFields: string[],
  requested: string[] | undefined,
): Record<string, unknown> {
  const allow = new Set(safeFields);
  const fields = requested ?? safeFields;
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (!allow.has(f)) continue;
    out[f] = row[f];
  }
  return out;
}

// ─── Descriptors ──────────────────────────────────────────────────

const facilitatorDescriptor: EntityDescriptor = {
  type: 'facilitator',
  label: 'Intervenant',
  safeFields: ['firstname', 'lastname', 'email', 'phone', 'color', 'bio'],
  maxListSize: 200,
  async list({ organizationId, limit }) {
    const rows = await prisma.facilitator.findMany({
      where: { organizationId, isBookable: true },
      orderBy: [{ lastname: 'asc' }, { firstname: 'asc' }],
      take: Math.min(limit ?? 100, 200),
      select: {
        id: true,
        firstname: true,
        lastname: true,
        email: true,
        phone: true,
        color: true,
        bio: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      label: `${r.firstname} ${r.lastname}`.trim(),
      fields: {
        firstname: r.firstname,
        lastname: r.lastname,
        email: r.email,
        phone: r.phone,
        color: r.color,
        bio: r.bio,
      },
    }));
  },
  async resolve({ organizationId, id, extractFields }) {
    const row = await prisma.facilitator.findFirst({
      where: { id, organizationId, isBookable: true },
      select: {
        id: true,
        firstname: true,
        lastname: true,
        email: true,
        phone: true,
        color: true,
        bio: true,
      },
    });
    if (!row) return null;
    return {
      id: row.id,
      label: `${row.firstname} ${row.lastname}`.trim(),
      fields: pickSafe(
        row as unknown as Record<string, unknown>,
        facilitatorDescriptor.safeFields,
        extractFields,
      ),
    };
  },
};

const roomDescriptor: EntityDescriptor = {
  type: 'room',
  label: 'Salle',
  safeFields: ['name', 'color', 'locationId'],
  maxListSize: 200,
  async list({ organizationId, limit }) {
    const rows = await prisma.room.findMany({
      where: { organizationId },
      orderBy: { name: 'asc' },
      take: Math.min(limit ?? 100, 200),
      select: { id: true, name: true, color: true, locationId: true },
    });
    return rows.map((r) => ({
      id: r.id,
      label: r.name,
      fields: { name: r.name, color: r.color, locationId: r.locationId },
    }));
  },
  async resolve({ organizationId, id, extractFields }) {
    const row = await prisma.room.findFirst({
      where: { id, organizationId },
      select: { id: true, name: true, color: true, locationId: true },
    });
    if (!row) return null;
    return {
      id: row.id,
      label: row.name,
      fields: pickSafe(
        row as unknown as Record<string, unknown>,
        roomDescriptor.safeFields,
        extractFields,
      ),
    };
  },
};

const clientDescriptor: EntityDescriptor = {
  type: 'client',
  label: 'Client',
  // NOTE: birthdate + address NOT in safeFields — never exposed via
  // a public picker. Flows that need them must look them up via an
  // ACTION node with admin scope (not yet built).
  safeFields: ['firstname', 'lastname', 'email', 'phone'],
  maxListSize: 200,
  async list({ organizationId, limit }) {
    const rows = await prisma.client.findMany({
      where: { organizationId },
      orderBy: [{ lastname: 'asc' }, { firstname: 'asc' }],
      take: Math.min(limit ?? 100, 200),
      select: {
        id: true,
        firstname: true,
        lastname: true,
        email: true,
        phone: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      label: `${r.firstname} ${r.lastname}`.trim(),
      fields: {
        firstname: r.firstname,
        lastname: r.lastname,
        email: r.email,
        phone: r.phone,
      },
    }));
  },
  async resolve({ organizationId, id, extractFields }) {
    const row = await prisma.client.findFirst({
      where: { id, organizationId },
      select: {
        id: true,
        firstname: true,
        lastname: true,
        email: true,
        phone: true,
      },
    });
    if (!row) return null;
    return {
      id: row.id,
      label: `${row.firstname} ${row.lastname}`.trim(),
      fields: pickSafe(
        row as unknown as Record<string, unknown>,
        clientDescriptor.safeFields,
        extractFields,
      ),
    };
  },
};

const serviceDescriptor: EntityDescriptor = {
  type: 'service',
  label: 'Prestation',
  safeFields: ['name', 'description', 'defaultDurationMinutes', 'defaultPrice'],
  maxListSize: 200,
  async list({ organizationId, limit }) {
    const rows = await prisma.service.findMany({
      where: { organizationId },
      orderBy: { name: 'asc' },
      take: Math.min(limit ?? 100, 200),
      select: {
        id: true,
        name: true,
        description: true,
        defaultDurationMinutes: true,
        defaultPrice: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      label: r.name,
      fields: {
        name: r.name,
        description: r.description,
        defaultDurationMinutes: r.defaultDurationMinutes,
        defaultPrice: r.defaultPrice,
      },
    }));
  },
  async resolve({ organizationId, id, extractFields }) {
    const row = await prisma.service.findFirst({
      where: { id, organizationId },
      select: {
        id: true,
        name: true,
        description: true,
        defaultDurationMinutes: true,
        defaultPrice: true,
      },
    });
    if (!row) return null;
    return {
      id: row.id,
      label: row.name,
      fields: pickSafe(
        row as unknown as Record<string, unknown>,
        serviceDescriptor.safeFields,
        extractFields,
      ),
    };
  },
};

// ─── Registry export ──────────────────────────────────────────────

export const ENTITY_REGISTRY: Record<EntityType, EntityDescriptor> = {
  facilitator: facilitatorDescriptor,
  room: roomDescriptor,
  client: clientDescriptor,
  service: serviceDescriptor,
};

export function getEntityDescriptor(type: string): EntityDescriptor | null {
  return (ENTITY_REGISTRY as Record<string, EntityDescriptor>)[type] ?? null;
}

export function isValidEntityType(value: unknown): value is EntityType {
  return (
    typeof value === 'string' && value in ENTITY_REGISTRY
  );
}

/**
 * Resolve a single entity by id, scoped to the flow's org.
 * Returns the public-safe shape (id + label + requested fields), or
 * null if the entity doesn't exist / belongs to another org / has been
 * soft-deleted (the Prisma extension filters those).
 */
export async function resolveEntity(params: {
  organizationId: string;
  type: string;
  id: string;
  extractFields?: string[];
}): Promise<ResolvedEntity | null> {
  const descriptor = getEntityDescriptor(params.type);
  if (!descriptor) return null;
  return descriptor.resolve({
    organizationId: params.organizationId,
    id: params.id,
    extractFields: params.extractFields,
  });
}

/**
 * Public-safe paginated list. `limit` is clamped to the descriptor's
 * server-side maximum.
 */
export async function listEntities(params: {
  organizationId: string;
  type: string;
  limit?: number;
}): Promise<ResolvedEntity[]> {
  const descriptor = getEntityDescriptor(params.type);
  if (!descriptor) return [];
  return descriptor.list({
    organizationId: params.organizationId,
    limit: params.limit,
  });
}

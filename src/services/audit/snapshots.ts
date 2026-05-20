/**
 * Snapshot helpers — produce JSON-safe scalar dumps of audited entities.
 *
 * Each function returns ONLY the entity's own scalar columns. Relations
 * (clients, facilitators, tags) are NOT serialized: they'd balloon the
 * audit row size, drift over time, and could include other-tenant data
 * by accident if the include shape changes. To inspect related-row
 * changes, walk the audit log of the related entity instead.
 *
 * Centralized in one module so:
 *   - we have a single place to update when adding/removing columns
 *   - we can swap to a generated approach later if it gets out of hand
 *   - the shapes are consistent across record / read sites
 *
 * Returns `null` when called with `null | undefined` — convenience for
 * "no before-state on CREATE" / "no after-state on DELETE".
 */

type Nullable<T> = T | null | undefined;

function dateToIso(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  return null;
}

export function snapshotScheduledEvent(e: Nullable<any>): object | null {
  if (!e) return null;
  return {
    id: e.id,
    startTime: dateToIso(e.startTime),
    endTime: dateToIso(e.endTime),
    color: e.color,
    price: e.price,
    notes: e.notes,
    status: e.status,
    rescheduleCount: e.rescheduleCount,
    originalStartTime: dateToIso(e.originalStartTime),
    roomId: e.roomId,
    locationId: e.locationId,
    serviceId: e.serviceId,
    serviceCategoryId: e.serviceCategoryId,
    enrollmentId: e.enrollmentId,
    seriesId: e.seriesId,
  };
}

export function snapshotRecurrenceSeries(s: Nullable<any>): object | null {
  if (!s) return null;
  return {
    id: s.id,
    frequency: s.frequency,
    startDate: dateToIso(s.startDate),
    endDate: dateToIso(s.endDate),
    status: s.status,
    defaultColor: s.defaultColor,
    defaultPrice: s.defaultPrice,
    defaultNotes: s.defaultNotes,
    defaultRoomId: s.defaultRoomId,
    defaultLocationId: s.defaultLocationId,
    defaultServiceId: s.defaultServiceId,
  };
}

export function snapshotFacilitator(f: Nullable<any>): object | null {
  if (!f) return null;
  return {
    id: f.id,
    firstname: f.firstname,
    lastname: f.lastname,
    email: f.email,
    phone: f.phone,
    bio: f.bio,
    address: f.address,
    profilePictureUrl: f.profilePictureUrl,
    color: f.color,
    availability: f.availability,
    notes: f.notes,
    metadata: f.metadata,
    isBookable: f.isBookable,
    isBioDisplayed: f.isBioDisplayed,
    ageScores: f.ageScores,
    levelScores: f.levelScores,
    languages: f.languages,
    priorityWeight: f.priorityWeight,
  };
}

export function snapshotClient(c: Nullable<any>): object | null {
  if (!c) return null;
  return {
    id: c.id,
    firstname: c.firstname,
    lastname: c.lastname,
    email: c.email,
    phone: c.phone,
    birthdate: dateToIso(c.birthdate),
    address: c.address,
    notes: c.notes,
    metadata: c.metadata,
  };
}

export function snapshotService(s: Nullable<any>): object | null {
  if (!s) return null;
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    defaultDurationMinutes: s.defaultDurationMinutes,
    defaultPrice: s.defaultPrice,
    notes: s.notes,
    metadata: s.metadata,
    serviceCategoryId: s.serviceCategoryId,
    bookingMode: s.bookingMode,
  };
}

export function snapshotServiceCategory(c: Nullable<any>): object | null {
  if (!c) return null;
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    isDisplayed: c.isDisplayed,
    isBookable: c.isBookable,
  };
}

export function snapshotLocation(l: Nullable<any>): object | null {
  if (!l) return null;
  return {
    id: l.id,
    name: l.name,
    description: l.description,
    address: l.address,
  };
}

export function snapshotRoom(r: Nullable<any>): object | null {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    locationId: r.locationId,
    availability: r.availability,
    notes: r.notes,
    metadata: r.metadata,
  };
}

export function snapshotTag(t: Nullable<any>): object | null {
  if (!t) return null;
  return {
    id: t.id,
    label: t.label,
    parentId: t.parentId,
    metadata: t.metadata,
  };
}

export function snapshotTerm(t: Nullable<any>): object | null {
  if (!t) return null;
  return {
    id: t.id,
    name: t.name,
    startDate: dateToIso(t.startDate),
    endDate: dateToIso(t.endDate),
    locationId: t.locationId,
  };
}

export function snapshotClosure(c: Nullable<any>): object | null {
  if (!c) return null;
  return {
    id: c.id,
    name: c.name,
    startDate: dateToIso(c.startDate),
    endDate: dateToIso(c.endDate),
    locationId: c.locationId,
  };
}

export function snapshotEnrollment(e: Nullable<any>): object | null {
  if (!e) return null;
  return {
    id: e.id,
    serviceId: e.serviceId,
    clientId: e.clientId,
    locationId: e.locationId,
    facilitatorId: e.facilitatorId,
    roomId: e.roomId,
    termId: e.termId,
    weekday: e.weekday,
    startTime: e.startTime,
    durationMinutes: e.durationMinutes,
    startDate: dateToIso(e.startDate),
    endDate: dateToIso(e.endDate),
    priceCharged: e.priceCharged,
    pricingStrategy: e.pricingStrategy,
    status: e.status,
  };
}

/**
 * Compute the set of scalar fields that differ between two snapshots.
 * Used on the read side so the admin UI doesn't need to recompute
 * diffs client-side.
 *
 * Shallow comparison — JSON.stringify on each field. Arrays / objects
 * are compared by serialized equality. Adequate for diff display;
 * not adequate for semantic equality.
 */
export function diffSnapshots(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): string[] {
  if (!before && !after) return [];
  if (!before) return Object.keys(after ?? {});
  if (!after) return Object.keys(before);

  const keys = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const k of keys) {
    const a = JSON.stringify(before[k] ?? null);
    const b = JSON.stringify(after[k] ?? null);
    if (a !== b) changed.push(k);
  }
  return changed;
}

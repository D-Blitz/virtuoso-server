/**
 * Unified org-scoped search (N.5).
 *
 * One endpoint fans out per-entity `ILIKE` queries across the 9 entity
 * kinds the navbar search needs, then returns a typed, grouped result
 * payload: `{ kind, id, label, sublabel?, url, matchedField }`.
 *
 * Two call shapes:
 *  - `search(q)`               — initial all-groups payload, first page
 *                                per kind (DEFAULT_PAGE_SIZE each), with a
 *                                `total` per group so the UI knows when
 *                                to surface a "Load more".
 *  - `searchKind(q, kind, …)`  — paginated load of one kind, used by the
 *                                command-palette "Load more" affordance.
 *
 * v1 is pragmatic: `ILIKE '%q%'` over a short whitelist of columns per
 * entity, count + page in one round-trip via `$transaction`. Postgres
 * trigram (`pg_trgm`) is the natural upgrade when datasets grow — the
 * API stays the same.
 */

import type { Permission, Prisma } from '@prisma/client';
import prisma from '../prisma';

export type SearchKind =
  | 'facilitator'
  | 'room'
  | 'location'
  | 'client'
  | 'service'
  | 'invoice'
  | 'payment'
  | 'enrollment'
  | 'event';

export interface SearchHit {
  kind: SearchKind;
  id: string;
  /** Primary display string (e.g. "Marie Dupont", "Facture 2026-0042"). */
  label: string;
  /** Secondary line (e.g. email, status, amount). Optional. */
  sublabel: string | null;
  /** Tertiary line for the command-palette card. Optional. */
  meta: string | null;
  /** Where to navigate on click. */
  url: string;
  /** Which column matched — purely diagnostic, the UI may surface it. */
  matchedField: string;
  // ── Visual fields (N.5 polish 2026-06-08) ─────────────────────────
  /** Profile picture URL (facilitators). Falls back to `initials` + `color`. */
  image: string | null;
  /** Hex colour for the avatar / status chip. */
  color: string | null;
  /** 1-2 letters drawn over the colour avatar (people only). */
  initials: string | null;
  /** Lifecycle status surfaced as a pill (invoice / payment / enrollment / event). */
  status: string | null;
}

export interface SearchGroup {
  kind: SearchKind;
  label: string;
  hits: SearchHit[];
  /** Total matches for this kind (independent of the current page). */
  total: number;
}

export interface SearchResults {
  query: string;
  groups: SearchGroup[];
  /** Total matches across every visible group. */
  total: number;
}

export const SEARCH_PAGE_SIZE = 5;
export const SEARCH_MAX_LIMIT = 25;
const MIN_QUERY_LENGTH = 2;

/** Permission(s) a user must have to see each kind in the search payload. */
const KIND_PERMS: Record<SearchKind, Permission[]> = {
  facilitator: ['FACILITATOR_VIEW', 'FACILITATOR_MANAGE'],
  room: ['ROOM_MANAGE'],
  location: ['LOCATION_MANAGE'],
  client: ['CLIENT_VIEW', 'CLIENT_MANAGE'],
  service: ['SERVICE_MANAGE'],
  invoice: ['PAYMENT_VIEW', 'INVOICE_VIEW_ALL', 'INVOICE_VIEW_SCOPED'],
  payment: ['PAYMENT_VIEW'],
  enrollment: ['ENROLLMENT_MANAGE'],
  event: ['EVENT_VIEW', 'EVENT_MANAGE_ALL', 'EVENT_MANAGE_SCOPED'],
};

const KIND_LABELS: Record<SearchKind, string> = {
  facilitator: 'Intervenants',
  room: 'Salles',
  location: 'Établissements',
  client: 'Clients',
  service: 'Services',
  invoice: 'Factures',
  payment: 'Paiements',
  enrollment: 'Inscriptions',
  event: 'Événements',
};

const KIND_ORDER: SearchKind[] = [
  'client',
  'facilitator',
  'room',
  'location',
  'service',
  'enrollment',
  'event',
  'invoice',
  'payment',
];

function hasAny(perms: Set<Permission>, candidates: Permission[]): boolean {
  return candidates.some((p) => perms.has(p));
}

function isKindVisible(kind: SearchKind, perms: Set<Permission>): boolean {
  return hasAny(perms, KIND_PERMS[kind]);
}

function money(cents: number, currency: string = 'EUR'): string {
  return (cents / 100).toLocaleString('fr-FR', {
    style: 'currency',
    currency,
  });
}

function fmtDateTime(d: Date): string {
  return d.toLocaleString('fr-FR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function initialsOf(first?: string | null, last?: string | null): string {
  const f = (first ?? '').trim();
  const l = (last ?? '').trim();
  const parts = [f.charAt(0), l.charAt(0)].filter(Boolean);
  if (parts.length > 0) return parts.join('').toUpperCase();
  // Single token (label-only entities) — first two letters.
  const single = `${f}${l}`.trim();
  return single.slice(0, 2).toUpperCase() || '—';
}

/**
 * Deterministic colour from a string id — for entities that don't have an
 * explicit `color` column (clients, locations). Stable across requests so
 * the same client always gets the same avatar tint.
 */
function hashColor(seed: string): string {
  const palette = [
    '#5B8DEF', '#7A57D1', '#22A06B', '#E8985E', '#D85C5C',
    '#3FB3CC', '#A3A647', '#C4659A', '#6F7B85', '#4D72A1',
  ];
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  return palette[Math.abs(h) % palette.length];
}

// ── Where-clause builders (used for both findMany + count) ────────────

function facilitatorWhere(q: string): Prisma.FacilitatorWhereInput {
  return {
    OR: [
      { firstname: { contains: q, mode: 'insensitive' } },
      { lastname: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
      { phone: { contains: q, mode: 'insensitive' } },
    ],
  };
}

function roomWhere(q: string): Prisma.RoomWhereInput {
  return {
    OR: [
      { name: { contains: q, mode: 'insensitive' } },
      { notes: { contains: q, mode: 'insensitive' } },
    ],
  };
}

function locationWhere(q: string): Prisma.LocationWhereInput {
  return {
    OR: [
      { name: { contains: q, mode: 'insensitive' } },
      { address: { contains: q, mode: 'insensitive' } },
      { description: { contains: q, mode: 'insensitive' } },
    ],
  };
}

function clientWhere(q: string): Prisma.ClientWhereInput {
  return {
    OR: [
      { firstname: { contains: q, mode: 'insensitive' } },
      { lastname: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
      { phone: { contains: q, mode: 'insensitive' } },
    ],
  };
}

function serviceWhere(q: string): Prisma.ServiceWhereInput {
  return {
    OR: [
      { name: { contains: q, mode: 'insensitive' } },
      { description: { contains: q, mode: 'insensitive' } },
    ],
  };
}

function invoiceWhere(q: string): Prisma.InvoiceWhereInput {
  return {
    OR: [
      { number: { contains: q, mode: 'insensitive' } },
      {
        client: {
          OR: [
            { firstname: { contains: q, mode: 'insensitive' } },
            { lastname: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
          ],
        },
      },
    ],
  };
}

function paymentWhere(q: string): Prisma.PaymentWhereInput {
  return {
    OR: [
      { chequeNumber: { contains: q, mode: 'insensitive' } },
      { chequeDrawerName: { contains: q, mode: 'insensitive' } },
      { chequeBank: { contains: q, mode: 'insensitive' } },
      {
        client: {
          OR: [
            { firstname: { contains: q, mode: 'insensitive' } },
            { lastname: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
          ],
        },
      },
    ],
  };
}

function enrollmentWhere(q: string): Prisma.EnrollmentWhereInput {
  return {
    OR: [
      {
        client: {
          OR: [
            { firstname: { contains: q, mode: 'insensitive' } },
            { lastname: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
          ],
        },
      },
      { service: { name: { contains: q, mode: 'insensitive' } } },
    ],
  };
}

function eventWhere(q: string): Prisma.ScheduledEventWhereInput {
  return {
    OR: [
      { notes: { contains: q, mode: 'insensitive' } },
      { service: { name: { contains: q, mode: 'insensitive' } } },
      {
        clients: {
          some: {
            OR: [
              { firstname: { contains: q, mode: 'insensitive' } },
              { lastname: { contains: q, mode: 'insensitive' } },
            ],
          },
        },
      },
    ],
  };
}

export class SearchService {
  /**
   * Initial all-groups payload — first page per visible kind, each with
   * an exact `total` for the "Load more" affordance.
   */
  async search(
    query: string,
    permissions: Set<Permission>,
  ): Promise<SearchResults> {
    const q = query.trim();
    if (q.length < MIN_QUERY_LENGTH) {
      return { query: q, groups: [], total: 0 };
    }

    const visibleKinds = KIND_ORDER.filter((k) => isKindVisible(k, permissions));
    const settled = await Promise.all(
      visibleKinds.map((kind) =>
        this.runOne(kind, q, { offset: 0, limit: SEARCH_PAGE_SIZE }),
      ),
    );

    const groups: SearchGroup[] = settled
      .map((g, i) => ({
        kind: visibleKinds[i],
        label: KIND_LABELS[visibleKinds[i]],
        hits: g.hits,
        total: g.total,
      }))
      .filter((g) => g.total > 0);

    return {
      query: q,
      groups,
      total: groups.reduce((sum, g) => sum + g.total, 0),
    };
  }

  /**
   * Paginated load of a single kind — drives the palette's per-category
   * "Load more". Returns the same SearchGroup shape (so the client can
   * merge / replace cleanly).
   */
  async searchKind(
    query: string,
    kind: SearchKind,
    permissions: Set<Permission>,
    page: { offset: number; limit: number },
  ): Promise<SearchGroup | null> {
    const q = query.trim();
    if (q.length < MIN_QUERY_LENGTH) return null;
    if (!isKindVisible(kind, permissions)) return null;

    const clampedLimit = Math.min(Math.max(1, page.limit), SEARCH_MAX_LIMIT);
    const clampedOffset = Math.max(0, page.offset);
    const result = await this.runOne(kind, q, {
      offset: clampedOffset,
      limit: clampedLimit,
    });
    return {
      kind,
      label: KIND_LABELS[kind],
      hits: result.hits,
      total: result.total,
    };
  }

  // ── Per-entity dispatch ──────────────────────────────────────────

  private async runOne(
    kind: SearchKind,
    q: string,
    page: { offset: number; limit: number },
  ): Promise<{ hits: SearchHit[]; total: number }> {
    switch (kind) {
      case 'facilitator':
        return this.searchFacilitators(q, page);
      case 'room':
        return this.searchRooms(q, page);
      case 'location':
        return this.searchLocations(q, page);
      case 'client':
        return this.searchClients(q, page);
      case 'service':
        return this.searchServices(q, page);
      case 'invoice':
        return this.searchInvoices(q, page);
      case 'payment':
        return this.searchPayments(q, page);
      case 'enrollment':
        return this.searchEnrollments(q, page);
      case 'event':
        return this.searchEvents(q, page);
    }
  }

  // ── Per-entity queries ────────────────────────────────────────────
  // Each returns { hits[], total } via $transaction so the page query and
  // the count share one round-trip. The scoping extension pins to the
  // caller's org + excludes trashed / archived rows.

  private async searchFacilitators(q: string, p: { offset: number; limit: number }) {
    const where = facilitatorWhere(q);
    const [rows, total] = await prisma.$transaction([
      prisma.facilitator.findMany({
        where,
        skip: p.offset,
        take: p.limit,
        orderBy: [{ lastname: 'asc' }, { firstname: 'asc' }],
      }),
      prisma.facilitator.count({ where }),
    ]);
    const hits: SearchHit[] = rows.map((r) => ({
      kind: 'facilitator' as const,
      id: r.id,
      label: `${r.firstname} ${r.lastname}`.trim(),
      sublabel: r.email || r.phone || null,
      meta: r.isBookable ? null : 'non réservable',
      url: `/admin/prestataires/${r.id}`,
      matchedField: matchedFieldFor(q, [r.firstname, r.lastname, r.email, r.phone]),
      image: r.profilePictureUrl || null,
      color: r.color || hashColor(r.id),
      initials: initialsOf(r.firstname, r.lastname),
      status: r.isBookable ? null : 'NON_BOOKABLE',
    }));
    return { hits, total };
  }

  private async searchRooms(q: string, p: { offset: number; limit: number }) {
    const where = roomWhere(q);
    const [rows, total] = await prisma.$transaction([
      prisma.room.findMany({
        where,
        include: { location: { select: { name: true } } },
        skip: p.offset,
        take: p.limit,
        orderBy: { name: 'asc' },
      }),
      prisma.room.count({ where }),
    ]);
    const hits: SearchHit[] = rows.map((r) => ({
      kind: 'room' as const,
      id: r.id,
      label: r.name,
      sublabel: r.location?.name ?? null,
      meta: r.notes?.slice(0, 80) ?? null,
      url: `/admin/salles?focus=${r.id}`,
      matchedField: 'name',
      image: null,
      color: r.color || hashColor(r.id),
      initials: initialsOf(r.name),
      status: null,
    }));
    return { hits, total };
  }

  private async searchLocations(q: string, p: { offset: number; limit: number }) {
    const where = locationWhere(q);
    const [rows, total] = await prisma.$transaction([
      prisma.location.findMany({
        where,
        skip: p.offset,
        take: p.limit,
        orderBy: { name: 'asc' },
      }),
      prisma.location.count({ where }),
    ]);
    const hits: SearchHit[] = rows.map((r) => ({
      kind: 'location' as const,
      id: r.id,
      label: r.name,
      sublabel: r.address || null,
      meta: r.description?.slice(0, 100) ?? null,
      url: `/admin/etablissements?focus=${r.id}`,
      matchedField: 'name',
      image: null,
      color: hashColor(r.id),
      initials: initialsOf(r.name),
      status: null,
    }));
    return { hits, total };
  }

  private async searchClients(q: string, p: { offset: number; limit: number }) {
    const where = clientWhere(q);
    const [rows, total] = await prisma.$transaction([
      prisma.client.findMany({
        where,
        skip: p.offset,
        take: p.limit,
        orderBy: [{ lastname: 'asc' }, { firstname: 'asc' }],
      }),
      prisma.client.count({ where }),
    ]);
    const hits: SearchHit[] = rows.map((r) => ({
      kind: 'client' as const,
      id: r.id,
      label: `${r.firstname} ${r.lastname}`.trim(),
      sublabel: r.email || r.phone || null,
      meta: r.address || null,
      url: `/admin/clients?focus=${r.id}`,
      matchedField: matchedFieldFor(q, [r.firstname, r.lastname, r.email, r.phone]),
      image: null,
      color: hashColor(r.id),
      initials: initialsOf(r.firstname, r.lastname),
      status: null,
    }));
    return { hits, total };
  }

  private async searchServices(q: string, p: { offset: number; limit: number }) {
    const where = serviceWhere(q);
    const [rows, total] = await prisma.$transaction([
      prisma.service.findMany({
        where,
        skip: p.offset,
        take: p.limit,
        orderBy: { name: 'asc' },
      }),
      prisma.service.count({ where }),
    ]);
    const hits: SearchHit[] = rows.map((r) => ({
      kind: 'service' as const,
      id: r.id,
      label: r.name,
      sublabel: `${r.defaultPrice ?? 0} € · ${r.defaultDurationMinutes ?? 0} min`,
      meta: r.description?.slice(0, 100) ?? null,
      url: `/admin/services?focus=${r.id}`,
      matchedField: 'name',
      image: null,
      color: hashColor(r.id),
      initials: initialsOf(r.name),
      status: r.bookingMode || null,
    }));
    return { hits, total };
  }

  private async searchInvoices(q: string, p: { offset: number; limit: number }) {
    const where = invoiceWhere(q);
    const [rows, total] = await prisma.$transaction([
      prisma.invoice.findMany({
        where,
        include: { client: { select: { firstname: true, lastname: true } } },
        skip: p.offset,
        take: p.limit,
        orderBy: { issueDate: 'desc' },
      }),
      prisma.invoice.count({ where }),
    ]);
    const hits: SearchHit[] = rows.map((r) => {
      const who = `${r.client?.firstname ?? ''} ${r.client?.lastname ?? ''}`.trim();
      return {
        kind: 'invoice' as const,
        id: r.id,
        label: `Facture ${r.number ?? r.id.slice(0, 8)}`,
        sublabel: `${who} — ${money(r.totalCents, r.currency)}`,
        meta: r.issueDate ? fmtDate(r.issueDate) : null,
        url: `/admin/invoices/${r.id}`,
        matchedField: r.number?.toLowerCase().includes(q.toLowerCase())
          ? 'number'
          : 'client',
        image: null,
        color: null,
        initials: null,
        status: r.status || null,
      };
    });
    return { hits, total };
  }

  private async searchPayments(q: string, p: { offset: number; limit: number }) {
    const where = paymentWhere(q);
    const [rows, total] = await prisma.$transaction([
      prisma.payment.findMany({
        where,
        include: { client: { select: { firstname: true, lastname: true } } },
        skip: p.offset,
        take: p.limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.payment.count({ where }),
    ]);
    const hits: SearchHit[] = rows.map((r) => {
      const who = `${r.client?.firstname ?? ''} ${r.client?.lastname ?? ''}`.trim();
      const what = `${money(r.amountCents, r.currency)} · ${r.method}`;
      return {
        kind: 'payment' as const,
        id: r.id,
        label: who || `Paiement ${r.id.slice(0, 8)}`,
        sublabel: what,
        meta: fmtDate(r.createdAt),
        url: `/admin/payments?focus=${r.id}`,
        matchedField: r.chequeNumber?.toLowerCase().includes(q.toLowerCase())
          ? 'chequeNumber'
          : 'client',
        image: null,
        color: null,
        initials: null,
        status: r.status || null,
      };
    });
    return { hits, total };
  }

  private async searchEnrollments(q: string, p: { offset: number; limit: number }) {
    const where = enrollmentWhere(q);
    const [rows, total] = await prisma.$transaction([
      prisma.enrollment.findMany({
        where,
        include: {
          client: { select: { firstname: true, lastname: true } },
          service: { select: { name: true } },
          term: { select: { name: true } },
        },
        skip: p.offset,
        take: p.limit,
        orderBy: { startDate: 'desc' },
      }),
      prisma.enrollment.count({ where }),
    ]);
    const hits: SearchHit[] = rows.map((r) => {
      const who =
        `${r.client?.firstname ?? ''} ${r.client?.lastname ?? ''}`.trim() ||
        `Inscription ${r.id.slice(0, 8)}`;
      return {
        kind: 'enrollment' as const,
        id: r.id,
        label: who,
        sublabel: `${r.service?.name ?? '—'}${r.term ? ` · ${r.term.name}` : ''}`,
        meta: `${fmtDate(r.startDate)} → ${fmtDate(r.endDate)}`,
        url: `/admin/enrollments/${r.id}`,
        matchedField: 'mixed',
        image: null,
        color: hashColor(r.id),
        initials: initialsOf(r.client?.firstname, r.client?.lastname),
        status: r.status || null,
      };
    });
    return { hits, total };
  }

  private async searchEvents(q: string, p: { offset: number; limit: number }) {
    const where = eventWhere(q);
    const [rows, total] = await prisma.$transaction([
      prisma.scheduledEvent.findMany({
        where,
        include: {
          service: { select: { name: true } },
          clients: { select: { firstname: true, lastname: true }, take: 1 },
          room: { select: { name: true } },
        },
        skip: p.offset,
        take: p.limit,
        orderBy: { startTime: 'desc' },
      }),
      prisma.scheduledEvent.count({ where }),
    ]);
    const hits: SearchHit[] = rows.map((r) => {
      const firstClient = r.clients[0];
      const who = firstClient
        ? `${firstClient.firstname} ${firstClient.lastname}`.trim()
        : '—';
      // Encode the calendar destination directly in the URL so the
      // calendar page can jump straight to the right day + location
      // without a follow-up fetch. `date` is the YYYY-MM-DD form of the
      // event's startTime (local) — selectedDate represents a day, the
      // time-of-day is irrelevant here.
      const start = r.startTime;
      const yyyy = start.getFullYear();
      const mm = String(start.getMonth() + 1).padStart(2, '0');
      const dd = String(start.getDate()).padStart(2, '0');
      const dateParam = `${yyyy}-${mm}-${dd}`;
      return {
        kind: 'event' as const,
        id: r.id,
        label: `${r.service?.name ?? 'Événement'} — ${fmtDateTime(r.startTime)}`,
        sublabel: who,
        meta: r.room?.name ? `Salle ${r.room.name}` : null,
        url: `/?focus=${r.id}&date=${dateParam}&location=${r.locationId}`,
        matchedField: r.notes?.toLowerCase().includes(q.toLowerCase())
          ? 'notes'
          : 'mixed',
        image: null,
        color: r.color || null,
        initials: null,
        status: r.status || null,
      };
    });
    return { hits, total };
  }
}

function matchedFieldFor(q: string, candidates: (string | null)[]): string {
  const lq = q.toLowerCase();
  const names = ['firstname', 'lastname', 'email', 'phone'];
  for (let i = 0; i < candidates.length; i++) {
    const v = candidates[i];
    if (v && v.toLowerCase().includes(lq)) {
      return names[i] ?? 'mixed';
    }
  }
  return 'mixed';
}

export function isSearchKind(value: unknown): value is SearchKind {
  return (
    typeof value === 'string' &&
    (KIND_ORDER as readonly string[]).includes(value)
  );
}

export const searchService = new SearchService();

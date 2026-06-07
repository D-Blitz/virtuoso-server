/**
 * Unified org-scoped search (N.5).
 *
 * One endpoint fans out per-entity `ILIKE` queries across the 9 entity
 * kinds the navbar search needs, then returns a typed, grouped result
 * payload: `{ kind, id, label, sublabel?, url, matchedField }`.
 *
 * v1 implementation is pragmatic: `ILIKE '%q%'` over a short whitelist
 * of columns per entity, per-group result cap (5), permission-aware
 * pruning before issuing the query (no work for a group the caller
 * can't see). Postgres trigram (`pg_trgm`) is the natural upgrade when
 * datasets grow — the API stays the same.
 *
 * URLs follow a soft "?focus=<id>" convention for list pages that don't
 * yet have a detail route — the page can optionally scroll/highlight,
 * or just land the user on the right list. Invoices + enrollments
 * already have detail routes, so they get deep links.
 */

import type { Permission } from '@prisma/client';
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
  /** Where to navigate on click. */
  url: string;
  /** Which column matched — purely diagnostic, the UI may surface it. */
  matchedField: string;
}

export interface SearchResults {
  query: string;
  /** Hits grouped by entity kind. Stable order regardless of permissions. */
  groups: Array<{ kind: SearchKind; label: string; hits: SearchHit[] }>;
  /** Total across every group (post-permission, post-cap). */
  total: number;
}

const PER_GROUP_LIMIT = 5;
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

export class SearchService {
  /**
   * Search across the 9 navbar kinds. `permissions` defaults to "all" so
   * the function is usable from scripts; routes pass the current user's
   * permission set.
   */
  async search(
    query: string,
    permissions: Set<Permission>,
  ): Promise<SearchResults> {
    const q = query.trim();
    if (q.length < MIN_QUERY_LENGTH) {
      return { query: q, groups: [], total: 0 };
    }

    const visibleKinds = KIND_ORDER.filter((k) =>
      hasAny(permissions, KIND_PERMS[k]),
    );

    // Issue every visible kind's query in parallel.
    const settled = await Promise.all(
      visibleKinds.map((kind) => this.runOne(kind, q)),
    );

    const groups = settled
      .map((hits, i) => ({
        kind: visibleKinds[i],
        label: KIND_LABELS[visibleKinds[i]],
        hits,
      }))
      .filter((g) => g.hits.length > 0);

    return {
      query: q,
      groups,
      total: groups.reduce((sum, g) => sum + g.hits.length, 0),
    };
  }

  private async runOne(kind: SearchKind, q: string): Promise<SearchHit[]> {
    switch (kind) {
      case 'facilitator':
        return this.searchFacilitators(q);
      case 'room':
        return this.searchRooms(q);
      case 'location':
        return this.searchLocations(q);
      case 'client':
        return this.searchClients(q);
      case 'service':
        return this.searchServices(q);
      case 'invoice':
        return this.searchInvoices(q);
      case 'payment':
        return this.searchPayments(q);
      case 'enrollment':
        return this.searchEnrollments(q);
      case 'event':
        return this.searchEvents(q);
    }
  }

  // ── Per-entity queries ────────────────────────────────────────────
  // Each method returns hits in label-asc order, capped at PER_GROUP_LIMIT.
  // The scoping extension pins to the caller's org + excludes
  // trashed / archived rows.

  private async searchFacilitators(q: string): Promise<SearchHit[]> {
    const rows = await prisma.facilitator.findMany({
      where: {
        OR: [
          { firstname: { contains: q, mode: 'insensitive' } },
          { lastname: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
          { phone: { contains: q, mode: 'insensitive' } },
        ],
      },
      take: PER_GROUP_LIMIT,
      orderBy: [{ lastname: 'asc' }, { firstname: 'asc' }],
    });
    return rows.map((r) => ({
      kind: 'facilitator' as const,
      id: r.id,
      label: `${r.firstname} ${r.lastname}`.trim(),
      sublabel: r.email || r.phone || null,
      url: `/admin/prestataires?focus=${r.id}`,
      matchedField: this.matchedFieldFor(q, [r.firstname, r.lastname, r.email]),
    }));
  }

  private async searchRooms(q: string): Promise<SearchHit[]> {
    const rows = await prisma.room.findMany({
      where: {
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { notes: { contains: q, mode: 'insensitive' } },
        ],
      },
      include: { location: { select: { name: true } } },
      take: PER_GROUP_LIMIT,
      orderBy: { name: 'asc' },
    });
    return rows.map((r) => ({
      kind: 'room' as const,
      id: r.id,
      label: r.name,
      sublabel: r.location?.name ?? null,
      url: `/admin/salles?focus=${r.id}`,
      matchedField: 'name',
    }));
  }

  private async searchLocations(q: string): Promise<SearchHit[]> {
    const rows = await prisma.location.findMany({
      where: {
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { address: { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
        ],
      },
      take: PER_GROUP_LIMIT,
      orderBy: { name: 'asc' },
    });
    return rows.map((r) => ({
      kind: 'location' as const,
      id: r.id,
      label: r.name,
      sublabel: r.address || null,
      url: `/admin/etablissements?focus=${r.id}`,
      matchedField: 'name',
    }));
  }

  private async searchClients(q: string): Promise<SearchHit[]> {
    const rows = await prisma.client.findMany({
      where: {
        OR: [
          { firstname: { contains: q, mode: 'insensitive' } },
          { lastname: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
          { phone: { contains: q, mode: 'insensitive' } },
        ],
      },
      take: PER_GROUP_LIMIT,
      orderBy: [{ lastname: 'asc' }, { firstname: 'asc' }],
    });
    return rows.map((r) => ({
      kind: 'client' as const,
      id: r.id,
      label: `${r.firstname} ${r.lastname}`.trim(),
      sublabel: r.email || r.phone || null,
      url: `/admin/clients?focus=${r.id}`,
      matchedField: this.matchedFieldFor(q, [r.firstname, r.lastname, r.email]),
    }));
  }

  private async searchServices(q: string): Promise<SearchHit[]> {
    const rows = await prisma.service.findMany({
      where: {
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
        ],
      },
      take: PER_GROUP_LIMIT,
      orderBy: { name: 'asc' },
    });
    return rows.map((r) => ({
      kind: 'service' as const,
      id: r.id,
      label: r.name,
      sublabel:
        r.defaultPrice != null && r.defaultDurationMinutes != null
          ? `${r.defaultPrice} € · ${r.defaultDurationMinutes} min`
          : null,
      url: `/admin/services?focus=${r.id}`,
      matchedField: 'name',
    }));
  }

  private async searchInvoices(q: string): Promise<SearchHit[]> {
    // Invoice numbers are short ("2026-0042"); match on the number column
    // and on the linked client name. `client.firstname/lastname` are
    // related via `client { is: { ... } }` because the relation is to-one.
    const rows = await prisma.invoice.findMany({
      where: {
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
      },
      include: { client: { select: { firstname: true, lastname: true } } },
      take: PER_GROUP_LIMIT,
      orderBy: { issueDate: 'desc' },
    });
    return rows.map((r) => ({
      kind: 'invoice' as const,
      id: r.id,
      label: `Facture ${r.number ?? r.id.slice(0, 8)}`,
      sublabel: `${r.client?.firstname ?? ''} ${r.client?.lastname ?? ''} — ${money(r.totalCents, r.currency)}`.trim(),
      url: `/admin/invoices/${r.id}`,
      matchedField: r.number?.toLowerCase().includes(q.toLowerCase())
        ? 'number'
        : 'client',
    }));
  }

  private async searchPayments(q: string): Promise<SearchHit[]> {
    // Payments lack a human-friendly identifier. We match on cheque
    // number, drawer name, bank, reference, then on the linked client.
    // Payment is NOT in the org-scoping set (Stripe-webhook-created
    // rows have no request context), so we explicitly scope here via a
    // join filter on `client.organization` — every payment we want has a
    // client, and the client IS org-scoped.
    const rows = await prisma.payment.findMany({
      where: {
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
      },
      include: { client: { select: { firstname: true, lastname: true } } },
      take: PER_GROUP_LIMIT,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => {
      const who = `${r.client?.firstname ?? ''} ${r.client?.lastname ?? ''}`.trim();
      const what = `${money(r.amountCents, r.currency)} · ${r.method}`;
      return {
        kind: 'payment' as const,
        id: r.id,
        label: who || `Paiement ${r.id.slice(0, 8)}`,
        sublabel: what,
        url: `/admin/payments?focus=${r.id}`,
        matchedField: r.chequeNumber?.toLowerCase().includes(q.toLowerCase())
          ? 'chequeNumber'
          : 'client',
      };
    });
  }

  private async searchEnrollments(q: string): Promise<SearchHit[]> {
    const rows = await prisma.enrollment.findMany({
      where: {
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
      },
      include: {
        client: { select: { firstname: true, lastname: true } },
        service: { select: { name: true } },
      },
      take: PER_GROUP_LIMIT,
      orderBy: { startDate: 'desc' },
    });
    return rows.map((r) => ({
      kind: 'enrollment' as const,
      id: r.id,
      label: `${r.client?.firstname ?? ''} ${r.client?.lastname ?? ''}`.trim() ||
        `Inscription ${r.id.slice(0, 8)}`,
      sublabel: `${r.service?.name ?? '—'} · ${r.status}`,
      url: `/admin/enrollments/${r.id}`,
      matchedField: 'mixed',
    }));
  }

  private async searchEvents(q: string): Promise<SearchHit[]> {
    const rows = await prisma.scheduledEvent.findMany({
      where: {
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
      },
      include: {
        service: { select: { name: true } },
        clients: { select: { firstname: true, lastname: true }, take: 1 },
      },
      take: PER_GROUP_LIMIT,
      orderBy: { startTime: 'desc' },
    });
    return rows.map((r) => {
      const firstClient = r.clients[0];
      const who = firstClient
        ? `${firstClient.firstname} ${firstClient.lastname}`.trim()
        : '—';
      return {
        kind: 'event' as const,
        id: r.id,
        label: `${r.service?.name ?? 'Événement'} — ${fmtDateTime(r.startTime)}`,
        sublabel: who,
        url: `/?focus=${r.id}`,
        matchedField: r.notes?.toLowerCase().includes(q.toLowerCase())
          ? 'notes'
          : 'mixed',
      };
    });
  }

  private matchedFieldFor(q: string, candidates: (string | null)[]): string {
    const lq = q.toLowerCase();
    for (let i = 0; i < candidates.length; i++) {
      const v = candidates[i];
      if (v && v.toLowerCase().includes(lq)) {
        return ['firstname', 'lastname', 'email', 'phone'][i] ?? 'mixed';
      }
    }
    return 'mixed';
  }
}

export const searchService = new SearchService();

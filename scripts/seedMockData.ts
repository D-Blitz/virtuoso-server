/**
 * Mock-data seed (N.6.6).
 *
 * Generates rich, idempotent test data into a dev org so the facilitator
 * UID page (and the Phase 3 dashboards that will reuse the same Chart +
 * Agenda components) have substantive numbers to render. Targets a single
 * org passed as argv[2] or resolved via `DEV_DEFAULT_ORG_ID` /
 * `organization.findFirst()`.
 *
 * What gets seeded:
 *   - 2 locations, 6 rooms (3 per location)
 *   - 1 service category, 5 services (piano, guitare, chant, …)
 *   - 1 term covering the whole mock window
 *   - 3 facilitators with full identity (photo URL, color, bio,
 *     availability, billing posture). Each gets a different split rule
 *     so the donut on each UID page tells a different story.
 *   - 25 clients
 *   - 12 months of historical events + 1 month of upcoming events
 *     (~3 events / week / facilitator → ~600 total) with mixed statuses
 *     (CANCELED rate ~8 %).
 *   - For every non-cancelled event: a Payment (mixed method) + 2
 *     PaymentAllocations (SCHOOL + FACILITATOR shares, per facilitator
 *     split rule).
 *
 * Idempotency: every seeded row uses a deterministic marker so a re-run
 * purges the previous mock set and re-seeds cleanly. Marker emails:
 *   `mock-fac-<n>@artcetera.test`, `mock-client-<n>@artcetera.test`
 * Marker names on non-person entities: prefixed with `[MOCK]`.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/seedMockData.ts [orgId]
 *   npx ts-node -r tsconfig-paths/register scripts/seedMockData.ts [orgId] --purge-only
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const raw = new PrismaClient();

const MOCK_PREFIX = '[MOCK]';
const MOCK_FAC_EMAIL = (n: number) => `mock-fac-${n}@artcetera.test`;
const MOCK_CLIENT_EMAIL = (n: number) => `mock-client-${n}@artcetera.test`;

// ── Config — tweak to grow or shrink the seed ────────────────────────
const MONTHS_BACK = 12;
const MONTHS_AHEAD = 1;
const EVENTS_PER_WEEK_PER_FAC = 3;
const CANCEL_RATE = 0.08;
const CLIENT_COUNT = 25;

const PAYMENT_METHODS = [
  { method: 'STRIPE', weight: 0.3 },
  { method: 'CHECK', weight: 0.2 },
  { method: 'CASH', weight: 0.25 },
  { method: 'BANK_TRANSFER', weight: 0.2 },
  { method: 'OTHER', weight: 0.05 },
];

// Static seed for reproducibility. Same seed → same draws across runs.
let RNG_STATE = 0x9e3779b9;
const rand = (): number => {
  // xorshift32 — small + deterministic + good enough for spread. We store
  // RNG_STATE as an unsigned 32-bit integer via `>>> 0`; dividing it
  // directly keeps the result in [0, 1). Using `& 0xffffffff` here would
  // re-interpret the result as a signed integer (can go negative) and
  // produce a negative ratio → negative array indices downstream.
  let x = RNG_STATE;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  RNG_STATE = x >>> 0;
  return RNG_STATE / 0x100000000;
};
const randInt = (min: number, max: number) =>
  Math.floor(rand() * (max - min + 1)) + min;
const randChoice = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
const weightedChoice = <T extends { weight: number }>(arr: T[]): T => {
  const total = arr.reduce((s, a) => s + a.weight, 0);
  let r = rand() * total;
  for (const a of arr) {
    r -= a.weight;
    if (r <= 0) return a;
  }
  return arr[arr.length - 1];
};

// ── Seed data ────────────────────────────────────────────────────────

const FACILITATORS = [
  {
    firstname: 'Sophie',
    lastname: 'Martin',
    email: MOCK_FAC_EMAIL(1),
    phone: '+33 6 11 22 33 44',
    bio: 'Pianiste classique, 12 ans d’enseignement. Spécialisée dans le répertoire romantique.',
    color: '#5B8DEF',
    profilePictureUrl: 'https://i.pravatar.cc/200?img=47',
    serviceKeys: ['piano-30', 'piano-60'],
    billingMode: 'BILLS_SCHOOL' as const,
    splitRuleMode: 'PERCENTAGE' as const,
    splitRuleValue: 70, // 70 % goes to her
  },
  {
    firstname: 'Lucas',
    lastname: 'Bernard',
    email: MOCK_FAC_EMAIL(2),
    phone: '+33 6 55 66 77 88',
    bio: 'Guitariste polyvalent (classique, jazz, fingerstyle). Méthode douce, niveau tous publics.',
    color: '#22A06B',
    profilePictureUrl: 'https://i.pravatar.cc/200?img=12',
    serviceKeys: ['guitare-30', 'guitare-60'],
    billingMode: 'BILLS_SCHOOL' as const,
    splitRuleMode: 'PERCENTAGE' as const,
    splitRuleValue: 65,
  },
  {
    firstname: 'Emma',
    lastname: 'Rousseau',
    email: MOCK_FAC_EMAIL(3),
    phone: '+33 6 99 88 77 66',
    bio: 'Chanteuse lyrique, professeur de chant. Cours individuels, préparation concours.',
    color: '#7A57D1',
    profilePictureUrl: 'https://i.pravatar.cc/200?img=32',
    serviceKeys: ['chant-60'],
    // School keeps everything → 100 % SCHOOL allocation on each payment.
    billingMode: 'NONE' as const,
    splitRuleMode: 'MANUAL' as const,
    splitRuleValue: 0,
  },
];

const SERVICES = [
  { key: 'piano-30', name: `${MOCK_PREFIX} Piano 30 min`, durationMinutes: 30, price: 28 },
  { key: 'piano-60', name: `${MOCK_PREFIX} Piano 60 min`, durationMinutes: 60, price: 50 },
  { key: 'guitare-30', name: `${MOCK_PREFIX} Guitare 30 min`, durationMinutes: 30, price: 26 },
  { key: 'guitare-60', name: `${MOCK_PREFIX} Guitare 60 min`, durationMinutes: 60, price: 46 },
  { key: 'chant-60', name: `${MOCK_PREFIX} Chant 60 min`, durationMinutes: 60, price: 55 },
];

const CLIENT_FIRSTNAMES = [
  'Léa', 'Adam', 'Mila', 'Hugo', 'Chloé', 'Louis', 'Inès', 'Gabriel',
  'Anna', 'Lucas', 'Manon', 'Noah', 'Jade', 'Raphaël', 'Camille',
  'Théo', 'Eva', 'Arthur', 'Sara', 'Tom', 'Lina', 'Nathan', 'Zoé',
  'Maxime', 'Alice',
];
const CLIENT_LASTNAMES = [
  'Dupont', 'Lefèvre', 'Bernard', 'Robert', 'Petit', 'Durand', 'Moreau',
  'Laurent', 'Simon', 'Michel', 'Garcia', 'David', 'Bertrand', 'Roux',
  'Vincent', 'Fournier', 'Morel', 'Girard', 'André', 'Mercier', 'Blanc',
  'Guérin', 'Boyer', 'Garnier', 'Chevalier',
];

const FULL_DAY_AVAILABILITY = {
  '1': [{ start: '09:00', end: '19:00' }],
  '2': [{ start: '09:00', end: '19:00' }],
  '3': [{ start: '09:00', end: '19:00' }],
  '4': [{ start: '09:00', end: '19:00' }],
  '5': [{ start: '09:00', end: '19:00' }],
  '6': [{ start: '10:00', end: '17:00' }],
};

// ── Purge ────────────────────────────────────────────────────────────

async function purge(organizationId: string): Promise<void> {
  // 1. Resolve the facilitator + client ids that belong to the previous
  //    mock run, so we can target their dependents precisely. Bypass the
  //    Prisma scoping extension by reading via the raw client.
  const facs = await raw.facilitator.findMany({
    where: {
      organizationId,
      email: { in: FACILITATORS.map((f, i) => MOCK_FAC_EMAIL(i + 1)) },
    },
    select: { id: true },
  });
  const facIds = facs.map((f) => f.id);
  const clients = await raw.client.findMany({
    where: {
      organizationId,
      email: { startsWith: 'mock-client-', endsWith: '@artcetera.test' },
    },
    select: { id: true },
  });
  const clientIds = clients.map((c) => c.id);

  // 2. Allocations → Payments → ScheduledEvents → Enrollments. Order
  //    matters: child rows before parents.
  if (clientIds.length > 0) {
    await raw.paymentAllocation.deleteMany({
      where: { payment: { clientId: { in: clientIds } } },
    });
    await raw.payment.deleteMany({ where: { clientId: { in: clientIds } } });
    await raw.invoice.deleteMany({ where: { clientId: { in: clientIds } } });
    await raw.scheduledEvent.deleteMany({
      where: { clients: { some: { id: { in: clientIds } } } },
    });
    await raw.enrollment.deleteMany({ where: { clientId: { in: clientIds } } });
  }
  if (facIds.length > 0) {
    // Any remaining events that referenced a mock facilitator but not a
    // mock client (defensive — shouldn't happen).
    await raw.scheduledEvent.deleteMany({
      where: { facilitators: { some: { id: { in: facIds } } } },
    });
    await raw.billingIdentity.deleteMany({
      where: { facilitatorId: { in: facIds } },
    });
  }

  // 3. Clients + facilitators themselves.
  if (clientIds.length > 0) {
    await raw.client.deleteMany({ where: { id: { in: clientIds } } });
  }
  if (facIds.length > 0) {
    await raw.facilitator.deleteMany({ where: { id: { in: facIds } } });
  }

  // 4. [MOCK]-named catalog rows (services, rooms, locations, category, term).
  await raw.scheduledEvent.deleteMany({
    where: {
      organizationId,
      service: { name: { startsWith: MOCK_PREFIX } },
    },
  });
  await raw.service.deleteMany({
    where: { organizationId, name: { startsWith: MOCK_PREFIX } },
  });
  await raw.serviceCategory.deleteMany({
    where: { organizationId, name: { startsWith: MOCK_PREFIX } },
  });
  await raw.term.deleteMany({
    where: { organizationId, name: { startsWith: MOCK_PREFIX } },
  });
  await raw.room.deleteMany({
    where: { organizationId, name: { startsWith: MOCK_PREFIX } },
  });
  await raw.location.deleteMany({
    where: { organizationId, name: { startsWith: MOCK_PREFIX } },
  });
}

// ── Seed ─────────────────────────────────────────────────────────────

async function seed(organizationId: string): Promise<void> {
  console.log('Seeding catalog…');

  // Locations + rooms.
  const locationNames = [
    `${MOCK_PREFIX} Studio Central`,
    `${MOCK_PREFIX} Annexe Nord`,
  ];
  const locations = await Promise.all(
    locationNames.map((name) =>
      raw.location.create({
        data: {
          organizationId,
          name,
          description: 'Établissement seed mock — données de test.',
          address: '10 rue de la Musique, 75001 Paris',
        },
      }),
    ),
  );
  const rooms = [];
  for (const loc of locations) {
    for (let i = 1; i <= 3; i++) {
      rooms.push(
        await raw.room.create({
          data: {
            organizationId,
            locationId: loc.id,
            name: `${MOCK_PREFIX} ${loc.name.replace(`${MOCK_PREFIX} `, '')} – Salle ${i}`,
            color: randChoice(['#5B8DEF', '#22A06B', '#E8985E', '#D85C5C', '#3FB3CC']),
            availability: {},
          },
        }),
      );
    }
  }

  // Service category + services.
  const category = await raw.serviceCategory.create({
    data: {
      organizationId,
      name: `${MOCK_PREFIX} Cours de musique`,
      description: 'Catégorie seed mock — données de test.',
      isDisplayed: true,
      isBookable: true,
    },
  });
  const services: Record<string, { id: string; defaultDurationMinutes: number; defaultPrice: number }> = {};
  for (const s of SERVICES) {
    const row = await raw.service.create({
      data: {
        organizationId,
        serviceCategoryId: category.id,
        name: s.name,
        description: 'Service seed mock — données de test.',
        defaultDurationMinutes: s.durationMinutes,
        defaultPrice: s.price,
        bookingMode: 'LESSON',
      },
    });
    services[s.key] = {
      id: row.id,
      defaultDurationMinutes: row.defaultDurationMinutes,
      defaultPrice: row.defaultPrice,
    };
  }

  // Term covering the mock window.
  const now = new Date();
  const termStart = new Date(now);
  termStart.setMonth(termStart.getMonth() - MONTHS_BACK);
  const termEnd = new Date(now);
  termEnd.setMonth(termEnd.getMonth() + MONTHS_AHEAD);
  const term = await raw.term.create({
    data: {
      organizationId,
      name: `${MOCK_PREFIX} Saison 2026`,
      startDate: termStart,
      endDate: termEnd,
    },
  });

  // Facilitators.
  console.log('Seeding facilitators…');
  const facilitators = [];
  for (const f of FACILITATORS) {
    const created = await raw.facilitator.create({
      data: {
        organizationId,
        firstname: f.firstname,
        lastname: f.lastname,
        email: f.email,
        phone: f.phone,
        bio: f.bio,
        color: f.color,
        profilePictureUrl: f.profilePictureUrl,
        availability: FULL_DAY_AVAILABILITY,
        isBookable: true,
        isBioDisplayed: true,
        billingMode: f.billingMode,
        splitRuleMode: f.splitRuleMode,
        splitRuleValue: f.splitRuleValue,
        priorityWeight: 1.0,
        languages: ['fr-FR'],
        locations: { connect: locations.map((l) => ({ id: l.id })) },
      },
    });
    facilitators.push({ ...f, id: created.id });
  }

  // Clients.
  console.log('Seeding clients…');
  const clients = [];
  for (let i = 1; i <= CLIENT_COUNT; i++) {
    const fn = CLIENT_FIRSTNAMES[(i - 1) % CLIENT_FIRSTNAMES.length];
    const ln = CLIENT_LASTNAMES[(i - 1) % CLIENT_LASTNAMES.length];
    const client = await raw.client.create({
      data: {
        organizationId,
        firstname: fn,
        lastname: ln,
        email: MOCK_CLIENT_EMAIL(i),
        phone: `+33 6 ${String(randInt(10, 99))} ${String(randInt(10, 99))} ${String(randInt(10, 99))} ${String(randInt(10, 99))}`,
        birthdate: new Date(2000 + randInt(0, 22), randInt(0, 11), randInt(1, 28)),
        address: `${randInt(1, 99)} rue du ${randChoice(['Conservatoire', 'Théâtre', 'Marché', 'Parc', 'Musée'])}, ${randInt(75001, 75020)} Paris`,
      },
    });
    clients.push(client);
  }

  // Events + payments + allocations.
  console.log('Seeding events + payments + allocations…');
  const windowStart = new Date(now);
  windowStart.setMonth(windowStart.getMonth() - MONTHS_BACK);
  windowStart.setHours(0, 0, 0, 0);
  const windowEnd = new Date(now);
  windowEnd.setMonth(windowEnd.getMonth() + MONTHS_AHEAD);

  const totalWeeks = Math.floor(
    (windowEnd.getTime() - windowStart.getTime()) / (7 * 24 * 3600_000),
  );
  let createdEvents = 0;
  let createdPayments = 0;

  for (const fac of facilitators) {
    const facServices = fac.serviceKeys.map((k) => ({ key: k, ...services[k] }));
    for (let w = 0; w < totalWeeks; w++) {
      for (let s = 0; s < EVENTS_PER_WEEK_PER_FAC; s++) {
        // Random weekday (1..6) + hour.
        const weekday = randInt(1, 6);
        const hour = randInt(9, 18);
        const minute = randChoice([0, 30]);

        const start = new Date(windowStart);
        start.setDate(start.getDate() + w * 7 + (weekday - 1));
        start.setHours(hour, minute, 0, 0);

        // Skip events that fall outside the window after stepping.
        if (start.getTime() > windowEnd.getTime()) continue;

        const svc = randChoice(facServices);
        const end = new Date(start.getTime() + svc.defaultDurationMinutes * 60_000);
        const room = randChoice(rooms);
        const client = randChoice(clients);

        const canceled = rand() < CANCEL_RATE;
        const event = await raw.scheduledEvent.create({
          data: {
            organizationId,
            startTime: start,
            endTime: end,
            color: fac.color,
            price: svc.defaultPrice,
            notes: '',
            status: canceled ? 'CANCELED' : 'SCHEDULED',
            roomId: room.id,
            locationId: room.locationId,
            serviceId: svc.id,
            serviceCategoryId: category.id,
            facilitators: { connect: [{ id: fac.id }] },
            clients: { connect: [{ id: client.id }] },
            ...(canceled
              ? { canceledAt: start, cancellationReason: 'Seed mock — annulation' }
              : {}),
          },
        });
        createdEvents++;

        if (canceled) continue;
        // Don't create payments for events in the future.
        if (start.getTime() > now.getTime()) continue;

        const method = weightedChoice(PAYMENT_METHODS).method;
        const amountCents = Math.round(svc.defaultPrice * 100);
        const payment = await raw.payment.create({
          data: {
            organizationId,
            clientId: client.id,
            amountCents,
            currency: 'EUR',
            status: 'SUCCEEDED',
            purpose: 'TRIAL_LESSON',
            method,
            receivedAt: method === 'STRIPE' ? null : start,
            relatedScheduledEventId: event.id,
            createdAt: start,
          },
        });
        createdPayments++;

        // Allocations — SCHOOL + FACILITATOR slices per the fac's split.
        const facPct = fac.billingMode === 'NONE' ? 0 : fac.splitRuleValue;
        const facShare = Math.round((amountCents * facPct) / 100);
        const schoolShare = amountCents - facShare;
        const allocCreate = [
          {
            organizationId,
            paymentId: payment.id,
            beneficiaryType: 'SCHOOL',
            amountCents: schoolShare,
            createdAt: start,
          },
        ];
        if (facShare > 0) {
          allocCreate.push({
            organizationId,
            paymentId: payment.id,
            beneficiaryType: 'FACILITATOR',
            facilitatorId: fac.id,
            amountCents: facShare,
            createdAt: start,
          } as any);
        }
        await raw.paymentAllocation.createMany({ data: allocCreate });
      }
    }
  }

  console.log(
    `\n✓ ${facilitators.length} facilitators, ${clients.length} clients, ` +
      `${createdEvents} events, ${createdPayments} payments seeded.`,
  );
  console.log(
    `  Term: ${term.name}, window ${termStart.toLocaleDateString('fr-FR')} → ${termEnd.toLocaleDateString('fr-FR')}.`,
  );
  console.log('  Facilitator URLs:');
  for (const fac of facilitators) {
    console.log(
      `   • ${fac.firstname} ${fac.lastname} → /admin/prestataires/${fac.id}`,
    );
  }
}

async function main(): Promise<void> {
  const organizationId =
    process.argv[2] && !process.argv[2].startsWith('--')
      ? process.argv[2]
      : (process.env.DEV_DEFAULT_ORG_ID ??
          (await raw.organization.findFirst({ select: { id: true } }))?.id);

  if (!organizationId) {
    console.error(
      'No organization found — pass an id as argv[2] or set DEV_DEFAULT_ORG_ID.',
    );
    process.exit(1);
  }
  const org = await raw.organization.findUnique({
    where: { id: organizationId },
    select: { name: true },
  });
  if (!org) {
    console.error(`Organization ${organizationId} not found.`);
    process.exit(1);
  }
  console.log(`\nSeed mock — org "${org.name}" (${organizationId})\n`);

  const purgeOnly = process.argv.includes('--purge-only');
  console.log('Purging previous mock data…');
  await purge(organizationId);

  if (purgeOnly) {
    console.log('\n✓ Purge complete (no seed).');
    return;
  }

  await seed(organizationId);
}

void main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => raw.$disconnect());

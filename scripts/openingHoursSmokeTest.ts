/**
 * Smoke test for venue opening hours + room inheritance.
 *
 * Covers the three things that are easy to get subtly wrong:
 *   - resolveRoomAvailability picks room override > venue hours > {}
 *   - `{}` on a room is an OVERRIDE ("never open"), not "unset"
 *   - applyOpeningHoursToRooms CLEARS overrides (so rooms keep tracking
 *     the venue) rather than copying hours in, and is idempotent
 *
 * Talks to the DB directly — no server needed. Everything it creates is
 * prefixed [hours-smoke] and removed in the finally block, so it never
 * touches real locations or rooms.
 *
 * Usage:
 *   npx ts-node scripts/openingHoursSmokeTest.ts [organizationId]
 */
import 'dotenv/config';

import { PrismaClient, Prisma } from '@prisma/client';

import {
  resolveRoomAvailability,
  roomInheritsHours,
} from '../src/domain/availability/roomAvailability';
import { LocationService } from '../src/services/location.service';

const prisma = new PrismaClient();
const locationService = new LocationService();

let assertionCount = 0;
let failureCount = 0;

function assert(cond: unknown, label: string): void {
  assertionCount += 1;
  if (!cond) {
    failureCount += 1;
    console.error(`  ❌  ${label}`);
  } else {
    console.log(`  ✅  ${label}`);
  }
}

/**
 * Key-order-insensitive stringify. JSONB normalises object key order on
 * the way out (`end` sorts before `start`), so a plain JSON.stringify
 * comparison fails on values that are actually identical.
 */
function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`)
    .join(',')}}`;
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  assertionCount += 1;
  if (stable(actual) === stable(expected)) {
    console.log(`  ✅  ${label}`);
  } else {
    failureCount += 1;
    console.error(`  ❌  ${label}`);
    console.error(`      expected: ${JSON.stringify(expected)}`);
    console.error(`      actual:   ${JSON.stringify(actual)}`);
  }
}

const VENUE_HOURS = {
  '1': [{ start: '09:00', end: '12:00' }],
  '3': [{ start: '14:00', end: '18:00' }],
};
const ROOM_HOURS = { '2': [{ start: '10:00', end: '11:00' }] };

async function purge(organizationId: string) {
  const locs = await prisma.location.findMany({
    where: { organizationId, name: { startsWith: '[hours-smoke]' } },
    select: { id: true },
  });
  if (locs.length === 0) return;
  const ids = locs.map((l) => l.id);
  await prisma.room.deleteMany({ where: { locationId: { in: ids } } });
  await prisma.location.deleteMany({ where: { id: { in: ids } } });
}

async function main() {
  const organizationId =
    process.argv[2] ??
    process.env.DEV_DEFAULT_ORG_ID ??
    'clxorg000000000000000001';
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
  });
  if (!org) {
    console.error(`Organization ${organizationId} not found.`);
    process.exit(1);
  }
  console.log(`\nOpening-hours smoke — org "${org.name}"\n`);

  await purge(organizationId);

  try {
    // ── 1. Pure resolution ──────────────────────────────────
    console.log('1. resolveRoomAvailability precedence');
    assertEq(
      resolveRoomAvailability({ availability: null }, { openingHours: VENUE_HOURS }),
      VENUE_HOURS,
      'null room availability inherits the venue',
    );
    assertEq(
      resolveRoomAvailability(
        { availability: ROOM_HOURS },
        { openingHours: VENUE_HOURS },
      ),
      ROOM_HOURS,
      'a room override wins over the venue',
    );
    assertEq(
      resolveRoomAvailability({ availability: {} }, { openingHours: VENUE_HOURS }),
      {},
      '`{}` is an override meaning "never open", NOT "unset"',
    );
    assertEq(
      resolveRoomAvailability({ availability: null }, { openingHours: null }),
      {},
      'no hours anywhere resolves to {}',
    );
    assert(roomInheritsHours({ availability: null }), 'null → inherits');
    assert(!roomInheritsHours({ availability: {} }), '{} → does not inherit');

    // ── 2. Seed a venue with three rooms ────────────────────
    console.log('\n2. Venue with inheriting + overriding rooms');
    const location = await prisma.location.create({
      data: {
        organizationId,
        name: '[hours-smoke] Studio',
        address: '1 rue Test',
        openingHours: VENUE_HOURS,
      },
      select: { id: true, openingHours: true },
    });
    assertEq(location.openingHours, VENUE_HOURS, 'venue stores openingHours');

    const mk = (name: string, availability: Prisma.InputJsonValue | null) =>
      prisma.room.create({
        data: {
          organizationId,
          locationId: location.id,
          name,
          color: '#999999',
          availability: availability ?? Prisma.DbNull,
        },
        select: { id: true, name: true, availability: true },
      });

    const inheriting = await mk('[hours-smoke] A', null);
    const overriding = await mk('[hours-smoke] B', ROOM_HOURS);
    const neverOpen = await mk('[hours-smoke] C', {});

    assertEq(inheriting.availability, null, 'room A stored as NULL');
    assertEq(overriding.availability, ROOM_HOURS, 'room B kept its override');
    assertEq(neverOpen.availability, {}, 'room C kept its empty override');

    assertEq(
      resolveRoomAvailability(inheriting, location),
      VENUE_HOURS,
      'room A resolves to the venue hours',
    );
    assertEq(
      resolveRoomAvailability(neverOpen, location),
      {},
      'room C stays closed despite the venue being open',
    );

    // ── 3. Which rooms would the bulk action touch? ─────────
    console.log('\n3. getRoomsWithCustomHours');
    const targets = await locationService.getRoomsWithCustomHours(location.id);
    assertEq(
      targets.map((r) => r.name).sort(),
      ['[hours-smoke] B', '[hours-smoke] C'],
      'lists exactly the two overriding rooms (not the inheriting one)',
    );

    // ── 4. Applying clears overrides ────────────────────────
    console.log('\n4. applyOpeningHoursToRooms');
    const result = await locationService.applyOpeningHoursToRooms(location.id);
    assertEq(
      { reset: result.reset, alreadyInheriting: result.alreadyInheriting, total: result.total },
      { reset: 2, alreadyInheriting: 1, total: 3 },
      'counts: 2 reset, 1 already inheriting, 3 total',
    );

    const after = await prisma.room.findMany({
      where: { locationId: location.id },
      select: { name: true, availability: true },
      orderBy: { name: 'asc' },
    });
    assert(
      after.every((r) => r.availability === null),
      'every room now follows the venue',
    );

    // The point of clearing rather than copying: a later venue edit
    // reaches the rooms with no second bulk action.
    const NEW_HOURS = { '5': [{ start: '08:00', end: '20:00' }] };
    await prisma.location.update({
      where: { id: location.id },
      data: { openingHours: NEW_HOURS },
    });
    const reread = await prisma.location.findUniqueOrThrow({
      where: { id: location.id },
      select: { openingHours: true },
    });
    assertEq(
      resolveRoomAvailability(after[1], reread),
      NEW_HOURS,
      'changing the venue reaches previously-overriding rooms automatically',
    );

    // ── 5. Idempotent ───────────────────────────────────────
    console.log('\n5. Re-running is a no-op');
    const second = await locationService.applyOpeningHoursToRooms(location.id);
    assertEq(second.reset, 0, 'second run resets nothing');
    assertEq(second.alreadyInheriting, 3, 'all three already inheriting');
  } finally {
    await purge(organizationId);
    console.log('\nCleaned up.');
  }

  console.log(`\n${assertionCount} assertions, ${failureCount} failures\n`);
  process.exit(failureCount === 0 ? 0 : 1);
}

main()
  .catch((err) => {
    console.error('\n💥 Smoke crashed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

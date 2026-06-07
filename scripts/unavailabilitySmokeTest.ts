/**
 * Unavailability smoke test (N.4).
 *
 * DB-backed regression guard for UnavailabilityService + the booking-flow
 * integrations: the availability slot suggester drops blocked windows and
 * the ScheduledEvent validator raises FACILITATOR_BLOCKED / ROOM_BLOCKED
 * warnings on overlap.
 *
 * Drives services directly inside a faked request context (no HTTP / no
 * auth). Seeds a throwaway facilitator + room + service in the resolved
 * org, then deletes them at the end.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/unavailabilitySmokeTest.ts [organizationId]
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

import { requestContext, type RequestContext } from '../src/auth/context';
import { UnavailabilityService } from '../src/services/unavailability.service';
import { AvailabilityService } from '../src/services/availability.service';
import { validateScheduledEvent } from '../src/validations/scheduledEvent.validation';

const raw = new PrismaClient();
const service = new UnavailabilityService();
const availability = new AvailabilityService();

const FAC_EMAIL = 'smoke-unav-fac@test.io';
const ROOM_NAME = 'Smoke Unavailability Room';
const SERVICE_NAME = 'Smoke Unavailability Service';
const LOCATION_NAME = 'Smoke Unavailability Location';
const CLIENT_EMAIL = 'smoke-unav-client@test.io';

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

function assertEq<T>(actual: T, expected: T, label: string): void {
  assertionCount += 1;
  if (actual === expected) {
    console.log(`  ✅  ${label}`);
  } else {
    failureCount += 1;
    console.error(`  ❌  ${label}`);
    console.error(`      expected: ${JSON.stringify(expected)}`);
    console.error(`      actual:   ${JSON.stringify(actual)}`);
  }
}

async function expectThrow(fn: () => Promise<unknown>, label: string): Promise<void> {
  assertionCount += 1;
  try {
    await fn();
    failureCount += 1;
    console.error(`  ❌  ${label} (expected throw, none happened)`);
  } catch {
    console.log(`  ✅  ${label}`);
  }
}

async function ensureLocation(organizationId: string) {
  const existing = await raw.location.findFirst({
    where: { organizationId, name: LOCATION_NAME },
  });
  if (existing) return existing;
  return raw.location.create({
    data: { organizationId, name: LOCATION_NAME, description: '', address: '—' },
  });
}

async function ensureRoom(organizationId: string, locationId: string) {
  const existing = await raw.room.findFirst({
    where: { organizationId, name: ROOM_NAME },
  });
  if (existing) return existing;
  return raw.room.create({
    data: {
      organizationId,
      locationId,
      name: ROOM_NAME,
      color: '#888',
      availability: {},
    },
  });
}

async function ensureServiceCategory(organizationId: string) {
  const existing = await raw.serviceCategory.findFirst({
    where: { organizationId, name: 'Smoke Unavailability Category' },
  });
  if (existing) return existing;
  return raw.serviceCategory.create({
    data: {
      organizationId,
      name: 'Smoke Unavailability Category',
      description: '',
      isDisplayed: false,
      isBookable: false,
    },
  });
}

async function ensureService(
  organizationId: string,
  serviceCategoryId: string,
) {
  const existing = await raw.service.findFirst({
    where: { organizationId, name: SERVICE_NAME },
  });
  if (existing) return existing;
  return raw.service.create({
    data: {
      organizationId,
      serviceCategoryId,
      name: SERVICE_NAME,
      description: '',
      defaultDurationMinutes: 60,
      defaultPrice: 0,
      bookingMode: 'STANDARD',
    },
  });
}

async function ensureFacilitator(organizationId: string, locationId: string) {
  const existing = await raw.facilitator.findFirst({
    where: { organizationId, email: FAC_EMAIL },
  });
  if (existing) return existing;
  // Whole-day availability so the slot generator has options to pick from.
  const wholeDay = {
    '0': [{ start: '00:00', end: '23:59' }],
    '1': [{ start: '00:00', end: '23:59' }],
    '2': [{ start: '00:00', end: '23:59' }],
    '3': [{ start: '00:00', end: '23:59' }],
    '4': [{ start: '00:00', end: '23:59' }],
    '5': [{ start: '00:00', end: '23:59' }],
    '6': [{ start: '00:00', end: '23:59' }],
  };
  const created = await raw.facilitator.create({
    data: {
      organizationId,
      firstname: 'Smoke',
      lastname: 'Unav',
      email: FAC_EMAIL,
      phone: '+33000000000',
      color: '#444',
      availability: wholeDay,
      isBookable: true,
      isBioDisplayed: false,
    },
  });
  await raw.facilitator.update({
    where: { id: created.id },
    data: { locations: { connect: { id: locationId } } },
  });
  return created;
}

async function ensureClient(organizationId: string) {
  const existing = await raw.client.findFirst({
    where: { organizationId, email: CLIENT_EMAIL },
  });
  if (existing) return existing;
  return raw.client.create({
    data: {
      organizationId,
      firstname: 'Smoke',
      lastname: 'UnavClient',
      email: CLIENT_EMAIL,
      phone: '+33000000001',
      birthdate: new Date('1990-01-01'),
      address: '—',
    },
  });
}

async function purge(organizationId: string): Promise<void> {
  // unavailabilities cascade nothing; just hard-delete (bypass soft-delete).
  await raw.unavailability.deleteMany({ where: { organizationId } });
  await raw.client.deleteMany({
    where: { organizationId, email: CLIENT_EMAIL },
  });
  await raw.facilitator.deleteMany({
    where: { organizationId, email: FAC_EMAIL },
  });
  await raw.service.deleteMany({
    where: { organizationId, name: SERVICE_NAME },
  });
  await raw.serviceCategory.deleteMany({
    where: { organizationId, name: 'Smoke Unavailability Category' },
  });
  await raw.room.deleteMany({ where: { organizationId, name: ROOM_NAME } });
  await raw.location.deleteMany({
    where: { organizationId, name: LOCATION_NAME },
  });
}

async function main() {
  const organizationId =
    process.argv[2] ??
    process.env.DEV_DEFAULT_ORG_ID ??
    (await raw.organization.findFirst())?.id;
  if (!organizationId) {
    throw new Error('No organization found; pass an id as argv[2].');
  }
  const org = await raw.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { id: true, name: true },
  });
  console.log(`Running unavailability smoke against org "${org.name}".`);

  await purge(organizationId);

  const location = await ensureLocation(organizationId);
  const room = await ensureRoom(organizationId, location.id);
  const category = await ensureServiceCategory(organizationId);
  const svc = await ensureService(organizationId, category.id);
  const facilitator = await ensureFacilitator(organizationId, location.id);
  const client = await ensureClient(organizationId);

  const ctx: RequestContext = {
    userId: 'smoke-unavailability',
    organizationId,
    email: 'smoke-unavailability@test.io',
    roleId: null,
    roleName: 'OWNER',
    permissions: new Set(['EVENT_MANAGE_ALL', 'EVENT_VIEW']),
  };

  try {
    await requestContext.run(ctx, async () => {
      // ── 1. Single facilitator block ────────────────────────────────────
      console.log('\n1. Single facilitator block');
      const t0 = new Date();
      t0.setUTCDate(t0.getUTCDate() + 7);
      t0.setUTCHours(10, 0, 0, 0);
      const t1 = new Date(t0.getTime() + 60 * 60_000);
      const facBlocks = await service.create({
        startTime: t0.toISOString(),
        endTime: t1.toISOString(),
        reason: 'Arrêt maladie',
        facilitatorId: facilitator.id,
      });
      assertEq(facBlocks.length, 1, 'one-shot facilitator block returns one row');
      assertEq(facBlocks[0].facilitatorId, facilitator.id, 'block carries facilitator');
      assert(facBlocks[0].roomId == null, 'block has no roomId');
      assertEq(facBlocks[0].reason, 'Arrêt maladie', 'reason preserved');

      // ── 2. Single room block ───────────────────────────────────────────
      console.log('\n2. Single room block');
      const r0 = new Date(t0.getTime() + 24 * 3600_000);
      const r1 = new Date(r0.getTime() + 30 * 60_000);
      const roomBlocks = await service.create({
        startTime: r0.toISOString(),
        endTime: r1.toISOString(),
        reason: 'Travaux',
        roomId: room.id,
      });
      assertEq(roomBlocks.length, 1, 'one-shot room block returns one row');
      assertEq(roomBlocks[0].roomId, room.id, 'block carries room');
      assert(roomBlocks[0].facilitatorId == null, 'block has no facilitatorId');

      // ── 3. Resource invariant: exactly one of facilitator/room ─────────
      console.log('\n3. Resource invariant');
      await expectThrow(
        () =>
          service.create({
            startTime: t0.toISOString(),
            endTime: t1.toISOString(),
            facilitatorId: facilitator.id,
            roomId: room.id,
          }),
        'rejects when BOTH facilitator and room are set',
      );
      await expectThrow(
        () =>
          service.create({
            startTime: t0.toISOString(),
            endTime: t1.toISOString(),
          }),
        'rejects when NEITHER facilitator nor room is set',
      );

      // ── 4. Time invariant ──────────────────────────────────────────────
      console.log('\n4. Time invariant');
      await expectThrow(
        () =>
          service.create({
            startTime: t1.toISOString(),
            endTime: t0.toISOString(),
            facilitatorId: facilitator.id,
          }),
        'rejects when endTime <= startTime',
      );

      // ── 5. Listing ─────────────────────────────────────────────────────
      console.log('\n5. Listing');
      const all = await service.list({
        from: new Date(t0.getTime() - 24 * 3600_000),
        to: new Date(t0.getTime() + 7 * 24 * 3600_000),
      });
      assert(all.length >= 2, 'list returns the seeded blocks');
      const facOnly = await service.list({
        from: new Date(t0.getTime() - 24 * 3600_000),
        to: new Date(t0.getTime() + 7 * 24 * 3600_000),
        facilitatorId: facilitator.id,
      });
      assert(
        facOnly.every((u: any) => u.facilitatorId === facilitator.id),
        'list filters by facilitator',
      );

      // ── 6. Recurrence (WEEKLY × 4) materializes 4 rows ────────────────
      console.log('\n6. Weekly recurrence — 4 occurrences');
      const recStart = new Date(t0.getTime() + 14 * 24 * 3600_000);
      recStart.setUTCHours(9, 0, 0, 0);
      const recEnd = new Date(recStart.getTime() + 60 * 60_000);
      const recBound = new Date(recStart.getTime() + 21 * 24 * 3600_000); // ~3 weeks → 4 rows incl. start
      const recurring = await service.create({
        startTime: recStart.toISOString(),
        endTime: recEnd.toISOString(),
        facilitatorId: facilitator.id,
        recurrence: { frequency: 'WEEKLY', endDate: recBound.toISOString() },
      });
      assertEq(recurring.length, 4, 'WEEKLY × 22 days → 4 rows');
      const groupId = recurring[0].recurrenceGroupId;
      assert(!!groupId, 'recurrenceGroupId stamped on the first row');
      assert(
        recurring.every((r: any) => r.recurrenceGroupId === groupId),
        'all siblings share the same recurrenceGroupId',
      );
      assert(
        recurring.every((r: any) => r.recurrenceFrequency === 'WEEKLY'),
        'each sibling carries the recurrence rule',
      );

      // ── 7. Availability skips facilitator-blocked window ──────────────
      console.log('\n7. Slot suggester drops a blocked window');
      const slotsBefore = await availability.getAvailableSlots({
        serviceId: svc.id,
        facilitatorIds: [facilitator.id],
        from: new Date(t0.getTime() - 3600_000),
        to: new Date(t0.getTime() + 2 * 3600_000),
        locationId: location.id,
      });
      const slotsCoveringBlock = slotsBefore.filter(
        (s) =>
          new Date(s.startTime).getTime() < t1.getTime() &&
          new Date(s.endTime).getTime() > t0.getTime(),
      );
      assertEq(slotsCoveringBlock.length, 0, 'no slot overlaps the block');

      // ── 8. Validator surfaces FACILITATOR_BLOCKED ──────────────────────
      console.log('\n8. Validator: FACILITATOR_BLOCKED');
      const blockedFacResult = await validateScheduledEvent({
        startTime: t0.toISOString(),
        endTime: t1.toISOString(),
        roomId: room.id,
        locationId: location.id,
        serviceId: svc.id,
        price: 0,
        facilitators: [facilitator.id],
        clients: [client.id],
      });
      assert(
        blockedFacResult.issues.some(
          (i) => i.code === 'FACILITATOR_BLOCKED',
        ),
        'validator raises FACILITATOR_BLOCKED on overlap',
      );

      // ── 9. Validator surfaces ROOM_BLOCKED ────────────────────────────
      console.log('\n9. Validator: ROOM_BLOCKED');
      // Pick a different facilitator window for the test — schedule the
      // candidate at the room block window (r0..r1) on a free facilitator
      // time (no facilitator block there).
      const blockedRoomResult = await validateScheduledEvent({
        startTime: r0.toISOString(),
        endTime: r1.toISOString(),
        roomId: room.id,
        locationId: location.id,
        serviceId: svc.id,
        price: 0,
        facilitators: [facilitator.id],
        clients: [client.id],
      });
      assert(
        blockedRoomResult.issues.some((i) => i.code === 'ROOM_BLOCKED'),
        'validator raises ROOM_BLOCKED on overlap',
      );

      // ── 10. update ALL forbids time edits ─────────────────────────────
      console.log('\n10. update ALL forbids time-of-day edits');
      await expectThrow(
        () =>
          service.update(
            recurring[0].id,
            { startTime: new Date(recStart.getTime() + 3600_000).toISOString() },
            'ALL',
          ),
        'ALL scope refuses startTime change',
      );

      // ── 11. update ALL propagates reason ──────────────────────────────
      console.log('\n11. update ALL propagates the reason');
      await service.update(
        recurring[0].id,
        { reason: 'Sabbatique' },
        'ALL',
      );
      const refreshed = await raw.unavailability.findMany({
        where: { recurrenceGroupId: groupId! },
      });
      assert(
        refreshed.every((r) => r.reason === 'Sabbatique'),
        'every sibling now reads "Sabbatique"',
      );

      // ── 12. update THIS detaches from the group ───────────────────────
      console.log('\n12. update THIS detaches a single occurrence');
      const detached = await service.update(
        recurring[1].id,
        { reason: 'Exception' },
        'THIS',
      );
      assertEq(detached.reason, 'Exception', 'the row carries the patched reason');
      assert(detached.recurrenceGroupId == null, 'detached row has null groupId');
      assert(
        detached.recurrenceFrequency == null,
        'detached row clears recurrenceFrequency',
      );

      // ── 13. delete THIS soft-deletes one ──────────────────────────────
      console.log('\n13. delete THIS soft-deletes one row');
      const oneShotId = facBlocks[0].id;
      const deletedOne = await service.delete(oneShotId, 'THIS');
      assertEq(deletedOne.deletedIds.length, 1, 'one row deleted');
      const stillThere = await raw.unavailability.findFirst({
        where: { id: oneShotId, deletedAt: null },
      });
      assert(!stillThere, 'the row no longer reads on default scope');

      // ── 14. delete ALL soft-deletes the rest of the group ─────────────
      console.log('\n14. delete ALL soft-deletes every sibling');
      const remainingGroup = await raw.unavailability.findMany({
        where: { recurrenceGroupId: groupId!, deletedAt: null },
      });
      assert(remainingGroup.length > 0, 'group still has at least one live row');
      const anyGroupId = remainingGroup[0].id;
      const deletedGroup = await service.delete(anyGroupId, 'ALL');
      assert(
        deletedGroup.deletedIds.length === remainingGroup.length,
        'ALL deletes every live sibling',
      );
      const afterAllDelete = await raw.unavailability.findMany({
        where: { recurrenceGroupId: groupId!, deletedAt: null },
      });
      assertEq(afterAllDelete.length, 0, 'no live siblings remain after ALL delete');
    });
  } finally {
    await purge(organizationId);
    await raw.$disconnect();
  }

  console.log(
    `\n${assertionCount} assertions, ${failureCount} failures` +
      (failureCount === 0 ? '. All green.' : ''),
  );
  if (failureCount > 0) process.exitCode = 1;
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

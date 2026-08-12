/**
 * Smoke test for tenant onboarding.
 *
 * Walks the real path a new client takes: an operator creates the org,
 * the owner gets a single-use link, sets their own password, and can
 * then log in — with the operator never knowing that password.
 *
 * Also pins the things that must NOT work: a reused link, an expired
 * one, a tampered one, and logging in before the password is set.
 *
 * Everything created is prefixed [onboard-smoke] and removed in the
 * finally block.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/onboardingSmokeTest.ts
 */
import 'dotenv/config';

import { PrismaClient } from '@prisma/client';

import {
  PlatformService,
  hashSetupToken,
} from '../src/services/platform/platform.service';
import { AccountSetupService } from '../src/services/platform/accountSetup.service';
import { AuthService } from '../src/services/auth.service';

const prisma = new PrismaClient();
const platform = new PlatformService();
const setup = new AccountSetupService();
const auth = new AuthService();

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
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`  ✅  ${label}`);
  } else {
    failureCount += 1;
    console.error(`  ❌  ${label}`);
    console.error(`      expected: ${JSON.stringify(expected)}`);
    console.error(`      actual:   ${JSON.stringify(actual)}`);
  }
}

async function rejects(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

const SLUG = 'onboard-smoke-ecole';
const OWNER = 'onboard-smoke-owner@test.io';

async function purge() {
  const org = await prisma.organization.findUnique({
    where: { slug: SLUG },
    select: { id: true },
  });
  if (!org) return;
  // AuditLogEntry holds a RESTRICT FK to Organization.
  await prisma.auditLogEntry.deleteMany({
    where: { organizationId: org.id },
  });
  // UserSetupToken cascades from User.
  await prisma.user.deleteMany({ where: { organizationId: org.id } });
  await prisma.role.deleteMany({ where: { organizationId: org.id } });
  await prisma.organization.delete({ where: { id: org.id } });
}

function tokenFrom(setupUrl: string): string {
  return new URL(setupUrl).searchParams.get('token') ?? '';
}

async function main() {
  console.log('\nOnboarding smoke — org creation → owner sets password\n');
  await purge();

  try {
    // ── 1. Operator creates the org ─────────────────────────
    console.log('1. Creating the organization');
    const created = await platform.createOrganization({
      slug: SLUG,
      name: '[onboard-smoke] École Test',
      ownerEmail: OWNER,
      appBaseUrl: 'http://localhost:3000',
    });
    assertEq(created.organization.slug, SLUG, 'org created with the slug');
    assertEq(created.ownerEmail, OWNER, 'owner email recorded');
    assert(created.setupUrl.includes('/definir-mot-de-passe?token='), 'setup link returned');

    const orgId = created.organization.id;
    const roleCount = await prisma.role.count({
      where: { organizationId: orgId },
    });
    assertEq(roleCount, 3, 'starter roles seeded (otherwise nobody can log in)');

    const owner = await prisma.user.findFirstOrThrow({
      where: { organizationId: orgId, email: OWNER },
      select: { id: true, passwordHash: true, roleRef: { select: { name: true } } },
    });
    assertEq(owner.passwordHash, null, 'owner has NO password yet');
    assertEq(owner.roleRef?.name, 'Propriétaire', 'owner got the owner role');

    // The operator must not be able to read the token back out.
    const stored = await prisma.userSetupToken.findFirstOrThrow({
      where: { userId: owner.id },
      select: { tokenHash: true },
    });
    const raw = tokenFrom(created.setupUrl);
    assert(
      stored.tokenHash !== raw && stored.tokenHash === hashSetupToken(raw),
      'only the token HASH is stored, never the raw value',
    );

    // ── 2. Can't get in before setting a password ───────────
    console.log('\n2. The account is inert until the link is used');
    assertEq(
      await auth.login(OWNER, 'anything'),
      null,
      'login refused while passwordHash is null',
    );

    // ── 3. Bad tokens are refused ───────────────────────────
    console.log('\n3. Invalid links are refused');
    assert(await rejects(() => setup.inspect('nope')), 'garbage token refused');
    assert(
      await rejects(() => setup.inspect(raw.slice(0, -1) + 'X')),
      'tampered token refused',
    );

    // ── 4. The owner uses the link ──────────────────────────
    console.log('\n4. Owner opens the link and sets a password');
    const info = await setup.inspect(raw);
    assertEq(info.email, OWNER, 'link identifies the right account');
    assertEq(info.purpose, 'INVITE', 'link is an invite');
    assert(
      await rejects(() => setup.complete(raw, 'short')),
      'password shorter than 8 chars refused',
    );

    await setup.complete(raw, 'un-mot-de-passe-choisi');
    const loggedIn = await auth.login(OWNER, 'un-mot-de-passe-choisi');
    assertEq(loggedIn?.organizationId, orgId, 'owner can now log in');
    assertEq(loggedIn?.hasAdminAccess, true, 'owner reaches the admin surface');

    // ── 5. The link is single-use ───────────────────────────
    console.log('\n5. The link cannot be reused');
    assert(await rejects(() => setup.inspect(raw)), 'consumed link is dead');
    assert(
      await rejects(() => setup.complete(raw, 'un-autre-mot-de-passe')),
      'consumed link cannot set a second password',
    );
    const stillWorks = await auth.login(OWNER, 'un-mot-de-passe-choisi');
    assert(stillWorks !== null, 'original password still valid after the replay attempt');

    // ── 6. Expiry ───────────────────────────────────────────
    console.log('\n6. Expired links are refused');
    const expiredRaw = 'expired-token-for-the-smoke-test-0123456789';
    await prisma.userSetupToken.create({
      data: {
        userId: owner.id,
        tokenHash: hashSetupToken(expiredRaw),
        purpose: 'INVITE',
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    assert(await rejects(() => setup.inspect(expiredRaw)), 'expired link refused');

    // ── 7. Duplicate slug ───────────────────────────────────
    console.log('\n7. Slug collisions are refused');
    assert(
      await rejects(() =>
        platform.createOrganization({
          slug: SLUG,
          name: 'Autre',
          ownerEmail: 'someone@test.io',
          appBaseUrl: 'http://localhost:3000',
        }),
      ),
      'duplicate slug refused',
    );
    assert(
      await rejects(() =>
        platform.createOrganization({
          slug: 'Not A Slug!',
          name: 'Autre',
          ownerEmail: 'someone@test.io',
          appBaseUrl: 'http://localhost:3000',
        }),
      ),
      'malformed slug refused',
    );
  } finally {
    await purge();
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

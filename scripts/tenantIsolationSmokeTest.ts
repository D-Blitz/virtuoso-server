/**
 * Smoke test for tenant isolation of User + Role.
 *
 * These two models were left out of TENANT_SCOPED_MODELS while the
 * platform had a single organization, which made the gap invisible:
 * UserService.list / RoleService.list carried no organizationId filter,
 * so a second org would have seen the first one's staff — and been able
 * to fetch, edit and disable them by id.
 *
 * This runs the real services inside a real request context for two
 * throwaway orgs and asserts each one sees only its own rows.
 *
 * Also pins the queries that must KEEP working across orgs: login and
 * the auth middleware's role lookup run before any context exists, so
 * they must not be scoped.
 *
 * Everything it creates is prefixed [iso-smoke] and removed in the
 * finally block.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/tenantIsolationSmokeTest.ts
 */
import 'dotenv/config';

import { PrismaClient } from '@prisma/client';

import { requestContext, type RequestContext } from '../src/auth/context';
import { ALL_PERMISSIONS } from '../src/auth/permissions';
import { hashPassword } from '../src/auth/password';
import { seedOrgRoles } from '../src/services/role/seedOrgRoles';
import { RoleService } from '../src/services/role/role.service';
import { UserService } from '../src/services/user/user.service';
import { AuthService } from '../src/services/auth.service';

const prisma = new PrismaClient();
const users = new UserService();
const roles = new RoleService();
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

/** Run `fn` as if it were a request from `organizationId`. */
function asOrg<T>(
  organizationId: string,
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const ctx: RequestContext = {
    userId,
    organizationId,
    email: 'smoke@test.io',
    roleId: null,
    roleName: 'IsoSmoke',
    permissions: new Set(ALL_PERMISSIONS),
  };
  return requestContext.run(ctx, fn);
}

const SLUGS = ['iso-smoke-a', 'iso-smoke-b'];

async function purge() {
  const orgs = await prisma.organization.findMany({
    where: { slug: { in: SLUGS } },
    select: { id: true },
  });
  if (orgs.length === 0) return;
  const ids = orgs.map((o) => o.id);
  // The services under test write audit entries, and AuditLogEntry holds
  // a RESTRICT foreign key to Organization — so these have to go first
  // or the org delete is refused.
  await prisma.auditLogEntry.deleteMany({
    where: { organizationId: { in: ids } },
  });
  await prisma.user.deleteMany({ where: { organizationId: { in: ids } } });
  await prisma.role.deleteMany({ where: { organizationId: { in: ids } } });
  await prisma.organization.deleteMany({ where: { id: { in: ids } } });
}

async function main() {
  console.log('\nTenant isolation smoke — User + Role\n');
  await purge();

  try {
    // ── Seed two orgs, each with its own roles and one user ──
    console.log('1. Two orgs, each with seeded roles and a user');
    const orgA = await prisma.organization.create({
      data: { slug: SLUGS[0], name: '[iso-smoke] École A' },
      select: { id: true },
    });
    const orgB = await prisma.organization.create({
      data: { slug: SLUGS[1], name: '[iso-smoke] École B' },
      select: { id: true },
    });
    await seedOrgRoles(orgA.id);
    await seedOrgRoles(orgB.id);

    const passwordHash = await hashPassword('smoke-password');
    const userA = await prisma.user.create({
      data: {
        organizationId: orgA.id,
        email: 'iso-smoke-a@test.io',
        passwordHash,
      },
      select: { id: true },
    });
    const userB = await prisma.user.create({
      data: {
        organizationId: orgB.id,
        email: 'iso-smoke-b@test.io',
        passwordHash,
      },
      select: { id: true },
    });
    assert(orgA.id !== orgB.id, 'two distinct orgs created');

    // ── The actual leak ─────────────────────────────────────
    console.log('\n2. Each org lists only its own users');
    const listedA = await asOrg(orgA.id, userA.id, () => users.list());
    const listedB = await asOrg(orgB.id, userB.id, () => users.list());
    assertEq(
      listedA.map((u) => u.email),
      ['iso-smoke-a@test.io'],
      'org A sees only its own user',
    );
    assertEq(
      listedB.map((u) => u.email),
      ['iso-smoke-b@test.io'],
      'org B sees only its own user',
    );

    console.log('\n3. Each org lists only its own roles');
    const rolesA = await asOrg(orgA.id, userA.id, () => roles.list());
    const rolesB = await asOrg(orgB.id, userB.id, () => roles.list());
    assertEq(rolesA.length, 3, 'org A sees exactly its 3 seeded roles');
    assertEq(rolesB.length, 3, 'org B sees exactly its 3 seeded roles');
    assert(
      rolesA.every((r) => !rolesB.some((o) => o.id === r.id)),
      'no role id appears in both orgs',
    );

    // ── Cross-org access by id ──────────────────────────────
    console.log('\n4. Cross-org access by id is refused');
    const stolen = await asOrg(orgA.id, userA.id, () => users.getById(userB.id));
    assertEq(stolen, null, "org A cannot fetch org B's user by id");

    let updateBlocked = false;
    try {
      await asOrg(orgA.id, userA.id, () =>
        users.update(userB.id, { email: 'hijacked@test.io' }),
      );
    } catch {
      updateBlocked = true;
    }
    assert(updateBlocked, "org A cannot update org B's user by id");
    const stillB = await prisma.user.findUnique({
      where: { id: userB.id },
      select: { email: true },
    });
    assertEq(stillB?.email, 'iso-smoke-b@test.io', "org B's user is untouched");

    let disableBlocked = false;
    try {
      await asOrg(orgA.id, userA.id, () => users.disable(userB.id));
    } catch {
      disableBlocked = true;
    }
    assert(disableBlocked, "org A cannot disable org B's user");

    // ── What must still work across orgs ────────────────────
    // Login and the auth middleware run BEFORE any request context
    // exists. If scoping leaked into them, nobody could log in.
    console.log('\n5. Login still works for both orgs (runs context-free)');
    const loginA = await auth.login('iso-smoke-a@test.io', 'smoke-password');
    const loginB = await auth.login('iso-smoke-b@test.io', 'smoke-password');
    assertEq(loginA?.organizationId, orgA.id, 'org A user can log in');
    assertEq(loginB?.organizationId, orgB.id, 'org B user can log in');
    assertEq(
      await auth.login('iso-smoke-a@test.io', 'wrong'),
      null,
      'wrong password still rejected',
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

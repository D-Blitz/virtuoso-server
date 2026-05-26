// @ts-nocheck
//
// STALE — pre-Phase-0.3 auth model. Uses `User.role` freeform string;
// the live schema has `User.roleId` → Role table since the
// granular_permissions migration. Manage users via the admin UI's
// /admin/utilisateurs page or rewrite this script to look up Role
// rows by name (Propriétaire / Administrateur / Intervenant).
//
// Kept here for reference + future rewrite. @ts-nocheck so the
// engine's `tsc --noEmit` (which now covers scripts/) doesn't trip
// on the stale schema references.

/**
 * Create or update a user in the default organization.
 *
 * Usage:
 *   npx ts-node scripts/createUser.ts <role> <email> <password> [facilitatorId]
 *
 * <role>          OWNER | ADMIN | STAFF | FACILITATOR
 * [facilitatorId] Optional. Link this user to an existing Facilitator row
 *                 (only meaningful for role=FACILITATOR).
 *
 * Idempotent: re-running with the same email updates the password and role.
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import 'dotenv/config';

const prisma = new PrismaClient();

const VALID_ROLES = new Set(['OWNER', 'ADMIN', 'STAFF', 'FACILITATOR']);

async function main() {
  const [, , role, email, password, facilitatorId] = process.argv;
  if (!role || !email || !password) {
    console.error('Usage: ts-node scripts/createUser.ts <role> <email> <password> [facilitatorId]');
    process.exit(1);
  }
  if (!VALID_ROLES.has(role)) {
    console.error(`Invalid role "${role}". Must be one of: ${[...VALID_ROLES].join(', ')}`);
    process.exit(1);
  }

  const organizationId = process.env.DEV_DEFAULT_ORG_ID ?? 'clxorg000000000000000001';

  const org = await prisma.organization.findUnique({ where: { id: organizationId } });
  if (!org) {
    console.error(
      `Organization ${organizationId} not found. Run the migration first (npx prisma migrate deploy).`,
    );
    process.exit(1);
  }

  if (facilitatorId) {
    const fac = await prisma.facilitator.findFirst({
      where: { id: facilitatorId, organizationId },
    });
    if (!fac) {
      console.error(`Facilitator ${facilitatorId} not found in org ${org.slug}.`);
      process.exit(1);
    }
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const user = await prisma.user.upsert({
    where: { organizationId_email: { organizationId, email } },
    update: { passwordHash, role, facilitatorId: facilitatorId ?? null },
    create: {
      email,
      passwordHash,
      role,
      organizationId,
      facilitatorId: facilitatorId ?? null,
    },
  });

  console.log(
    `✅ User ready: ${user.email} (id=${user.id}, role=${user.role})` +
      (user.facilitatorId ? ` linked to facilitator ${user.facilitatorId}` : '') +
      ` in org ${org.slug}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

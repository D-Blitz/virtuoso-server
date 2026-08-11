/**
 * Create or update a user in the default organization.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/createUser.ts <role> <email> <password> [facilitatorId]
 *
 * <role>          owner | admin | intervenant — case-insensitive shorthand for
 *                 the seeded roles (Propriétaire / Administrateur / Intervenant),
 *                 so you don't have to type accents. An exact role name also
 *                 works, including custom roles the org has created.
 * [facilitatorId] Optional. Link this user to an existing Facilitator row.
 *
 * Idempotent: re-running with the same email updates password + role, and
 * reactivates the account if it had been disabled. Seeds the org's starter
 * roles first, so this works on a fresh database.
 */
import 'dotenv/config';
import prisma from '../src/prisma';
import { hashPassword } from '../src/auth/password';
import { seedOrgRoles } from '../src/services/role/seedOrgRoles';

const ROLE_ALIASES: Record<string, string> = {
  owner: 'Propriétaire',
  proprietaire: 'Propriétaire',
  admin: 'Administrateur',
  administrateur: 'Administrateur',
  intervenant: 'Intervenant',
};

async function main() {
  const [, , roleArg, emailArg, password, facilitatorId] = process.argv;
  if (!roleArg || !emailArg || !password) {
    console.error(
      'Usage: ts-node scripts/createUser.ts <role> <email> <password> [facilitatorId]',
    );
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Password must be at least 8 characters (matches UserService.create).');
    process.exit(1);
  }

  // AuthService.login matches the email verbatim and UserService lowercases on
  // write — normalise here too, or the credentials silently fail at sign-in.
  const email = emailArg.trim().toLowerCase();

  const organizationId = process.env.DEV_DEFAULT_ORG_ID ?? 'clxorg000000000000000001';

  const org = await prisma.organization.findUnique({ where: { id: organizationId } });
  if (!org) {
    console.error(
      `Organization ${organizationId} not found. Run npx prisma migrate deploy, then npm run seed.`,
    );
    process.exit(1);
  }

  // A fresh org has no Role rows — seed.ts only creates the Organization.
  // Idempotent, so re-running is free and never touches custom roles.
  await seedOrgRoles(organizationId);

  const roleName = ROLE_ALIASES[roleArg.toLowerCase()] ?? roleArg;
  const role = await prisma.role.findFirst({
    where: { organizationId, name: roleName },
    select: { id: true, name: true },
  });
  if (!role) {
    const available = await prisma.role.findMany({
      where: { organizationId },
      select: { name: true },
    });
    console.error(
      `Role "${roleName}" not found in org ${org.slug}. Available: ${available
        .map((r) => r.name)
        .join(', ')}`,
    );
    process.exit(1);
  }

  if (facilitatorId) {
    const fac = await prisma.facilitator.findFirst({
      where: { id: facilitatorId, organizationId },
      select: { id: true },
    });
    if (!fac) {
      console.error(`Facilitator ${facilitatorId} not found in org ${org.slug}.`);
      process.exit(1);
    }
  }

  const passwordHash = await hashPassword(password);

  const user = await prisma.user.upsert({
    where: { organizationId_email: { organizationId, email } },
    update: {
      passwordHash,
      roleId: role.id,
      facilitatorId: facilitatorId ?? null,
      disabledAt: null,
      disabledById: null,
    },
    create: {
      email,
      passwordHash,
      roleId: role.id,
      organizationId,
      facilitatorId: facilitatorId ?? null,
    },
  });

  console.log(
    `✅ User ready: ${user.email} (id=${user.id}, role=${role.name})` +
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
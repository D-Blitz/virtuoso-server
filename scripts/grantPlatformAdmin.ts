/**
 * Grant (or revoke) the platform-operator flag on a user.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/grantPlatformAdmin.ts <email> [--revoke]
 *
 * Deliberately CLI-only: there is no UI for this, because a surface that
 * can mint platform operators is a surface worth attacking. Granting it
 * requires shell access to the server.
 *
 * The user must already exist — create them with scripts/createUser.ts
 * first. Matching is by email across every organization, so it also
 * reports which org the account belongs to before flipping the flag.
 */
import 'dotenv/config';

import prisma from '../src/prisma';

async function main() {
  const [, , emailArg, ...flags] = process.argv;
  const revoke = flags.includes('--revoke');

  if (!emailArg) {
    console.error(
      'Usage: ts-node scripts/grantPlatformAdmin.ts <email> [--revoke]',
    );
    process.exit(1);
  }
  const email = emailArg.trim().toLowerCase();

  const user = await prisma.user.findFirst({
    where: { email },
    select: {
      id: true,
      email: true,
      isPlatformAdmin: true,
      organization: { select: { name: true, slug: true } },
    },
  });

  if (!user) {
    console.error(
      `No user with email "${email}". Create one first with scripts/createUser.ts.`,
    );
    process.exit(1);
  }

  if (user.isPlatformAdmin === !revoke) {
    console.log(
      `No change: ${user.email} is already ${revoke ? 'not ' : ''}a platform admin.`,
    );
    return;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { isPlatformAdmin: !revoke },
  });

  console.log(
    `✅ ${revoke ? 'Revoked' : 'Granted'} platform admin for ${user.email} ` +
      `(org: ${user.organization.name} / ${user.organization.slug})`,
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

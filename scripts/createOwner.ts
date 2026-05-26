// @ts-nocheck
//
// STALE — pre-Phase-0.3 auth model. See scripts/createUser.ts for
// the same drift notes. Use the admin UI's /admin/utilisateurs page
// to bootstrap users instead. Kept for reference + future rewrite.

/**
 * Create the first OWNER user for the default organization.
 *
 * Usage:
 *   npx ts-node scripts/createOwner.ts <email> <password>
 *
 * The script is idempotent: if a user with the given email already exists in the
 * org, its password and role are updated.
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import 'dotenv/config';

const prisma = new PrismaClient();

async function main() {
  const [, , email, password] = process.argv;
  if (!email || !password) {
    console.error('Usage: ts-node scripts/createOwner.ts <email> <password>');
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

  const passwordHash = await bcrypt.hash(password, 10);

  const user = await prisma.user.upsert({
    where: {
      organizationId_email: { organizationId, email },
    },
    update: { passwordHash, role: 'OWNER' },
    create: {
      email,
      passwordHash,
      role: 'OWNER',
      organizationId,
    },
  });

  console.log(`✅ OWNER user ready: ${user.email} (id=${user.id}) in org ${org.slug}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

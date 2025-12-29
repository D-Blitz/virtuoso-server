import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  const enrollmentId = '7236rv23r762f7862dfv89274';

  const deleted = await prisma.scheduledEvent.deleteMany({
    where: { enrollmentId },
  });

  console.log(`Deleted ${deleted.count} events`);
}

run()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const f = await prisma.facilitator.findUnique({
    where: { id: 'cmoyb7fub000fuz28nqvohcvb' },
    select: { firstname: true, lastname: true, profilePictureUrl: true, gallery: true },
  });
  console.log('Astrée:', JSON.stringify(f));
  const withPics = await prisma.facilitator.count({
    where: { profilePictureUrl: { not: null }, deletedAt: null },
  });
  console.log('Facilitators with a non-null profilePictureUrl:', withPics);
  await prisma.$disconnect();
})();

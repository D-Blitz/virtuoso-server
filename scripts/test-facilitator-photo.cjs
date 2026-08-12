require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const ID = 'cmoyb7fub000fuz28nqvohcvb';
const TEST = 'https://res.cloudinary.com/demo/image/upload/w_400,h_400,c_fill/sample.jpg';
(async () => {
  const before = await prisma.facilitator.findUnique({
    where: { id: ID },
    select: { profilePictureUrl: true },
  });
  console.log('before:', before && before.profilePictureUrl);
  await prisma.facilitator.update({
    where: { id: ID },
    data: { profilePictureUrl: TEST },
  });
  const after = await prisma.facilitator.findUnique({
    where: { id: ID },
    select: { profilePictureUrl: true },
  });
  console.log('after: ', after && after.profilePictureUrl);
  console.log(
    after && after.profilePictureUrl === TEST
      ? 'PRISMA UPDATE WORKS — backend persistence is fine'
      : 'PRISMA UPDATE FAILED — backend/schema problem',
  );
  await prisma.$disconnect();
})();

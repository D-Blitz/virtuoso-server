import { PrismaClient } from '@prisma/client';
import { faker } from '@faker-js/faker/locale/fr';

const prisma = new PrismaClient();

const DEFAULT_ORG_ID = 'clxorg000000000000000001';

function randomColor() {
  return `#${Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0')}`;
}

function fakeAvailability() {
  return {
    "1": [{ start: "09:00", end: "12:00" }],
    "2": [{ start: "14:00", end: "18:00" }],
    "4": [{ start: "10:00", end: "13:00" }],
  };
}

async function main() {

  console.log("🏢 Ensuring default organization...");
  const org = await prisma.organization.upsert({
    where: { id: DEFAULT_ORG_ID },
    update: {},
    create: {
      id: DEFAULT_ORG_ID,
      slug: 'artcetera',
      name: 'Art & Cetera',
    },
  });

  console.log("🌍 Creating locations...");
  const locations = await Promise.all([
    prisma.location.create({ data: { name: 'Nice Conservatory', description: 'Côte d’Azur campus', address: faker.location.streetAddress(), organizationId: org.id } }),
    prisma.location.create({ data: { name: 'Paris Music Studio', description: 'Central artistic hub', address: faker.location.streetAddress(), organizationId: org.id } }),
  ]);

  console.log("🚪 Creating rooms...");
  const rooms = await Promise.all(
    Array.from({ length: 4 }).map((_, i) =>
      prisma.room.create({
        data: {
          name: `Salle ${faker.word.words(1).toUpperCase()}`,
          color: randomColor(),
          availability: fakeAvailability(),
          notes: faker.lorem.sentence(),
          metadata: {},
          locationId: locations[i % locations.length].id,
          organizationId: org.id,
        },
      })
    )
  );

  console.log("👩‍🏫 Creating facilitators...");
  const facilitators = await Promise.all(
    Array.from({ length: 6 }).map(() => {
      const selectedLocations = faker.helpers.arrayElements(locations, faker.number.int({ min: 1, max: 2 }));
      return prisma.facilitator.create({
        data: {
          firstname: faker.person.firstName(),
          lastname: faker.person.lastName(),
          email: faker.internet.email(),
          phone: faker.phone.number(),
          bio: faker.lorem.paragraph(),
          address: faker.location.streetAddress(),
          profilePictureUrl: faker.image.avatar(),
          color: randomColor(),
          availability: fakeAvailability(),
          notes: faker.lorem.sentence(),
          metadata: {},
          isBookable: true,
          isBioDisplayed: true,
          organizationId: org.id,
          locations: {
            connect: selectedLocations.map(loc => ({ id: loc.id })),
          },
        },
      });
    })
  );

  console.log("🎓 Creating clients...");
  const clients = await Promise.all(
    Array.from({ length: 6 }).map(() =>
      prisma.client.create({
        data: {
          firstname: faker.person.firstName(),
          lastname: faker.person.lastName(),
          email: faker.internet.email(),
          phone: faker.phone.number(),
          birthdate: faker.date.birthdate({ min: 12, max: 60, mode: 'age' }),
          address: faker.location.streetAddress(),
          notes: faker.lorem.sentence(),
          metadata: {},
          organizationId: org.id,
        },
      })
    )
  );

  console.log("📚 Creating service categories...");
  const categories = await Promise.all([
    prisma.serviceCategory.create({ data: { name: "Cours", description: "Toutes nos formations", isDisplayed: true, isBookable: true, organizationId: org.id } }),
    prisma.serviceCategory.create({ data: { name: "Location", description: "Locations de salles", isDisplayed: true, isBookable: false, organizationId: org.id } }),
  ]);

  console.log("🏷 Creating tags...");
  const tags = await Promise.all(
    ["Piano", "Guitare", "Chant", "Batterie", "Violon"].map(label =>
      prisma.tag.create({ data: { label, metadata: {}, organizationId: org.id } })
    )
  );

  console.log("🧾 Creating services...");
  const services = await Promise.all(
    ["Cours Piano", "Cours Guitare", "Atelier Chant", "Cours Violon"].map((name, i) =>
      prisma.service.create({
        data: {
          name: `${name} ${faker.helpers.arrayElement(["débutant", "avancé", "intermédiaire"])}`,
          description: faker.lorem.sentences(2),
          defaultDurationMinutes: faker.helpers.arrayElement([30, 45, 60]),
          defaultPrice: faker.number.float({ min: 20, max: 80 }),
          notes: faker.lorem.sentence(),
          metadata: {},
          serviceCategoryId: categories[i % categories.length].id,
          organizationId: org.id,
          tags: {
            connect: [tags[i % tags.length]].map(tag => ({ id: tag.id })),
          },
          facilitators: {
            connect: facilitators
              .slice(i, i + 2)
              .map(f => ({ id: f.id })),
          },
        },
      })
    )
  );

  console.log("📅 Creating scheduled events...");
  for (let i = 0; i < 10; i++) {
    const room = faker.helpers.arrayElement(rooms);
    const associatedLocation = locations.find(loc => loc.id === room.locationId);
    if (!associatedLocation) continue;

    const service = faker.helpers.arrayElement(services);
    const serviceCategory = categories.find(cat => cat.id === service.serviceCategoryId)!;

    const facilitatorSubset = faker.helpers.arrayElements(facilitators, 2);
    const clientSubset = faker.helpers.arrayElements(clients, 2);
    const tagSubset = faker.helpers.arrayElements(tags, 2);

    const start = faker.date.future();
    const end = new Date(start.getTime() + faker.number.int({ min: 30, max: 90 }) * 60000);

    await prisma.scheduledEvent.create({
      data: {
        startTime: start,
        endTime: end,
        recurrence: null,
        color: randomColor(),
        roomId: room.id,
        locationId: associatedLocation.id,
        serviceId: service.id,
        serviceCategoryId: serviceCategory.id,
        organizationId: org.id,
        facilitators: { connect: facilitatorSubset.map(f => ({ id: f.id })) },
        clients: { connect: clientSubset.map(c => ({ id: c.id })) },
        tags: { connect: tagSubset.map(t => ({ id: t.id })) },
        price: 60.0,
      },
    });
  }

  console.log("✅ Seed completed successfully!");
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

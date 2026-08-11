/* One-off: geocode existing venues that have no coordinates, via the BAN API.
 * Run from the virtuoso-server root:  node scripts/backfill-venue-coords.cjs
 * Safe + idempotent — only fills venues where latitude is null. */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const venues = await prisma.location.findMany({
    where: { latitude: null, deletedAt: null, archivedAt: null },
    select: { id: true, name: true, address: true },
  });
  console.log(`Venues missing coordinates: ${venues.length}`);
  let ok = 0;
  for (const v of venues) {
    const addr = (v.address || '').trim();
    if (addr.length < 5) {
      console.log(`- skip "${v.name}" (no usable address)`);
      continue;
    }
    try {
      const res = await fetch(
        `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(addr)}&limit=1`,
      );
      const data = await res.json();
      const feat = data.features && data.features[0];
      if (feat && feat.geometry) {
        const [lng, lat] = feat.geometry.coordinates;
        await prisma.location.update({
          where: { id: v.id },
          data: { latitude: lat, longitude: lng },
        });
        ok++;
        console.log(`+ ${v.name} -> ${lat.toFixed(5)}, ${lng.toFixed(5)}  (${feat.properties.label})`);
      } else {
        console.log(`- no geocode match for "${v.name}" ("${addr}")`);
      }
    } catch (e) {
      console.log(`! error for "${v.name}": ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 200)); // be polite to the BAN API
  }
  console.log(`Done: geocoded ${ok}/${venues.length} venues.`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

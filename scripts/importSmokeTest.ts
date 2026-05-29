/**
 * Smoke test for the CSV bulk-import pipeline.
 *
 * Spins up an Express app with the import routes, drives preview +
 * commit via real HTTP fetch calls for two entity types (Location +
 * Facilitator), asserts:
 *   - preview catches invalid rows + counts them
 *   - commit creates new rows, updates re-runs, surfaces row errors
 *   - re-running the same CSV updates instead of duplicating
 *
 * Uses dev-auth-bypass: NODE_ENV != 'production' + DEV_AUTH_BYPASS=true
 * + DEV_DEFAULT_ORG_ID.
 *
 * Usage:
 *   npx ts-node scripts/importSmokeTest.ts [organizationId]
 */
import express from 'express';
import 'dotenv/config';

import { PrismaClient } from '@prisma/client';

import { requireUser } from '../src/middleware/auth';
import importRoutes from '../src/routes/import.routes';
import enginePrisma from '../src/prisma';

const prisma = new PrismaClient();

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
  if (actual === expected) {
    console.log(`  ✅  ${label}`);
  } else {
    failureCount += 1;
    console.error(`  ❌  ${label}`);
    console.error(`      expected: ${JSON.stringify(expected)}`);
    console.error(`      actual:   ${JSON.stringify(actual)}`);
  }
}

let baseUrl = '';

async function postCsv(
  path: string,
  csv: string,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/csv' },
    body: csv,
  });
  const json = (await res.json().catch(() => ({}))) as any;
  return { status: res.status, json };
}

function buildApp() {
  const app = express();
  app.use('/api', requireUser);
  app.use('/api/import', importRoutes);
  return app;
}

async function purgeSmokeData(organizationId: string) {
  await prisma.facilitator.deleteMany({
    where: {
      organizationId,
      email: { in: ['smoke-csv-1@test.io', 'smoke-csv-2@test.io'] },
    },
  });
  await prisma.location.deleteMany({
    where: {
      organizationId,
      name: { in: ['[csv-smoke] Studio A', '[csv-smoke] Studio B'] },
    },
  });
}

async function main() {
  const organizationId =
    process.argv[2] ??
    process.env.DEV_DEFAULT_ORG_ID ??
    'clxorg000000000000000001';
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
  });
  if (!org) {
    console.error(`Organization ${organizationId} not found.`);
    process.exit(1);
  }
  console.log(`\nCSV import smoke — org "${org.name}"\n`);

  process.env.DEV_AUTH_BYPASS = 'true';
  process.env.DEV_DEFAULT_ORG_ID = organizationId;

  await purgeSmokeData(organizationId);

  const app = buildApp();
  const server = app.listen(0);
  await new Promise<void>((r) => server.on('listening', () => r()));
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://localhost:${port}`;
  console.log(`Test server on ${baseUrl}\n`);

  try {
    // ── 1. Location: 2 valid + 1 missing required field ──────
    console.log('1. Location preview catches missing required field');
    const locCsv = [
      'name,address,description',
      '[csv-smoke] Studio A,1 rue Test,Petite salle',
      '[csv-smoke] Studio B,2 rue Test,', // empty desc ok
      ',3 rue Test,no name — should error',
    ].join('\n');
    {
      const r = await postCsv('/api/import/preview/location', locCsv);
      assertEq(r.status, 200, 'preview status = 200');
      assertEq(r.json.totalRows, 3, 'total rows = 3');
      assertEq(r.json.validRows, 2, 'valid rows = 2');
      assertEq(r.json.errorRows, 1, 'error rows = 1');
    }

    // ── 2. Location: commit good rows ───────────────────────
    console.log('\n2. Location commit creates good rows + errors out bad');
    {
      const r = await postCsv('/api/import/commit/location', locCsv);
      assertEq(r.status, 200, 'commit status = 200');
      assertEq(r.json.created, 2, '2 locations created');
      assertEq(r.json.errored, 1, '1 row errored');
    }

    // ── 3. Re-run: same CSV updates instead of duplicating ──
    console.log('\n3. Re-running same CSV upserts (no duplicates)');
    {
      const r = await postCsv('/api/import/commit/location', locCsv);
      assertEq(r.json.created, 0, 'second run: 0 created');
      assertEq(r.json.updated, 2, 'second run: 2 updated');
    }
    const locsInDb = await prisma.location.findMany({
      where: {
        organizationId,
        name: { startsWith: '[csv-smoke]' },
      },
    });
    assertEq(locsInDb.length, 2, 'exactly 2 smoke locations in DB after re-run');

    // ── 4. Facilitator: relation-free import ────────────────
    console.log('\n4. Facilitator preview + commit');
    const facCsv = [
      'firstname,lastname,email,phone,color,isBookable',
      'Alice,Smoke,smoke-csv-1@test.io,5555550101,#5b5bff,oui',
      'Bob,Smoke,smoke-csv-2@test.io,5555550102,#fa8072,oui',
      'Charlie,Smoke,not-an-email,5555550103,not-a-color,oui', // 2 errors
    ].join('\n');
    {
      const preview = await postCsv('/api/import/preview/facilitator', facCsv);
      assertEq(preview.json.totalRows, 3, 'fac total = 3');
      assertEq(preview.json.validRows, 2, 'fac valid = 2');
      assertEq(preview.json.errorRows, 1, 'fac errored = 1');
      const errRow = preview.json.rows.find((r: any) => r.errors.length > 0);
      assert(
        errRow.errors.some((e: string) => e.toLowerCase().includes('email')),
        'invalid-row reports email error',
      );
      assert(
        errRow.errors.some((e: string) =>
          e.toLowerCase().includes('couleur'),
        ),
        'invalid-row reports color error',
      );
    }
    {
      const commit = await postCsv('/api/import/commit/facilitator', facCsv);
      assertEq(commit.json.created, 2, '2 facilitators created');
      assertEq(commit.json.errored, 1, '1 facilitator row errored');
    }

    // ── 5. Template endpoint returns valid CSV ──────────────
    console.log('\n5. Template endpoint returns headers + example');
    {
      const res = await fetch(`${baseUrl}/api/import/template/facilitator`);
      assertEq(res.status, 200, 'template status = 200');
      const text = await res.text();
      const headerLine = text.split('\n')[0].replace(/^﻿/, '');
      assert(headerLine.includes('email'), 'template includes email column');
      assert(headerLine.includes('firstname'), 'template includes firstname');
    }

    // ── 6. Registry endpoint lists all 9 entities ──────────
    console.log('\n6. Registry endpoint surfaces all importable entities');
    {
      const res = await fetch(`${baseUrl}/api/import/registry`);
      const body = (await res.json()) as { entities: { type: string }[] };
      assertEq(res.status, 200, 'registry status = 200');
      assertEq(body.entities.length, 9, 'registry returns 9 entities');
      const types = new Set(body.entities.map((e) => e.type));
      ['location', 'facilitator', 'service', 'room', 'tag', 'serviceCategory', 'term', 'closure', 'client'].forEach(
        (t) => {
          assert(types.has(t), `registry includes "${t}"`);
        },
      );
    }

    // ── 7. Export endpoint round-trips through commit ───────
    console.log('\n7. Export endpoint returns CSV that re-imports clean');
    {
      const res = await fetch(`${baseUrl}/api/import/export/location`);
      assertEq(res.status, 200, 'export status = 200');
      const csv = await res.text();
      assert(csv.includes('[csv-smoke] Studio A'), 'export contains seeded row');
      assert(
        csv.split('\n')[0].replace(/^﻿/, '').startsWith('name,address'),
        'export header matches the import template',
      );
      // Re-import the export — should be all updates.
      const stripped = csv.replace(/^﻿/, '');
      const reimport = await postCsv('/api/import/commit/location', stripped);
      assertEq(reimport.json.created, 0, 'export re-import: 0 created');
      assert(reimport.json.updated >= 2, 'export re-import: ≥2 updated');
    }

    // ── 8. All-types endpoint enumerates dependency order ──
    console.log('\n8. /all/types returns dependency-ordered list');
    {
      const res = await fetch(`${baseUrl}/api/import/all/types`);
      const body = (await res.json()) as { types: string[] };
      assertEq(res.status, 200, 'all/types status = 200');
      assertEq(body.types.length, 9, 'all/types returns 9 entries');
      assertEq(body.types[0], 'location', 'first dep-order entry = location');
      assert(
        body.types.indexOf('location') < body.types.indexOf('room'),
        'location resolves before room',
      );
      assert(
        body.types.indexOf('serviceCategory') < body.types.indexOf('service'),
        'serviceCategory resolves before service',
      );
    }

    // ── 9. /all/preview + /all/commit batch processing ──────
    console.log('\n9. all/preview + all/commit process multiple entities');
    const allPayload = {
      location: 'name,address\n[csv-smoke] Studio C,3 rue Test',
      tag: 'label\n[csv-smoke] piano-débutant',
    };
    {
      const previewRes = await fetch(`${baseUrl}/api/import/all/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(allPayload),
      });
      const previewBody = (await previewRes.json()) as any;
      assertEq(previewRes.status, 200, 'all/preview status = 200');
      assertEq(
        previewBody.results.location.validRows,
        1,
        'preview location: 1 valid row',
      );
      assertEq(
        previewBody.results.tag.validRows,
        1,
        'preview tag: 1 valid row',
      );

      const commitRes = await fetch(`${baseUrl}/api/import/all/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(allPayload),
      });
      const commitBody = (await commitRes.json()) as any;
      assertEq(commitRes.status, 200, 'all/commit status = 200');
      assert(
        commitBody.results.location.created + commitBody.results.location.updated >= 1,
        'all/commit upserted the location',
      );
      assert(
        commitBody.results.tag.created + commitBody.results.tag.updated >= 1,
        'all/commit upserted the tag',
      );
      // Tag cleanup so re-running the smoke is idempotent.
      await prisma.tag.deleteMany({
        where: {
          organizationId,
          label: '[csv-smoke] piano-débutant',
        },
      });
      await prisma.location.deleteMany({
        where: {
          organizationId,
          name: '[csv-smoke] Studio C',
        },
      });
    }

    // ── 10. Unified single-CSV round-trip ────────────────────
    // One CSV with rows for multiple entity types. The leading
    // `type` column discriminates which spec validates each row.
    console.log('\n10. Unified single-CSV preview + commit');
    {
      const unified = [
        'type,name,address,description,label,startDate,endDate,location,firstname,lastname,email,phone,color,isBookable,isBioDisplayed',
        'location,[csv-smoke] Studio D,5 rue Test,,,,,,,,,,,,',
        'tag,,,,[csv-smoke] solfege,,,,,,,,,,',
        'facilitator,,,,,,,,Diane,SmokeUnified,smoke-unified@test.io,5555550501,#abcdef,oui,non',
        'invalid-type,X,Y,Z,,,,,,,,,,,',
      ].join('\n');

      const preview = await fetch(`${baseUrl}/api/import/unified/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/csv' },
        body: unified,
      });
      const previewBody = (await preview.json()) as any;
      assertEq(preview.status, 200, 'unified preview status = 200');
      assertEq(previewBody.totalRows, 4, 'unified preview: 4 total rows');
      assertEq(previewBody.validRows, 3, 'unified preview: 3 valid');
      assertEq(previewBody.errorRows, 1, 'unified preview: 1 errored (bogus type)');
      assert(
        previewBody.rowErrors.some(
          (r: any) =>
            r.errors.some((e: string) => e.toLowerCase().includes('inconnu')),
        ),
        'unified preview flags unknown type as error',
      );
      assertEq(
        previewBody.perType.location.validRows,
        1,
        'perType.location.validRows = 1',
      );
      assertEq(
        previewBody.perType.facilitator.validRows,
        1,
        'perType.facilitator.validRows = 1',
      );

      const commit = await fetch(`${baseUrl}/api/import/unified/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/csv' },
        body: unified,
      });
      const commitBody = (await commit.json()) as any;
      assertEq(commit.status, 200, 'unified commit status = 200');
      assert(
        commitBody.created + commitBody.updated >= 3,
        'unified commit: created+updated >= 3',
      );
      assertEq(commitBody.errored, 1, 'unified commit: 1 errored (bogus type)');

      // Export endpoint produces a unified CSV that round-trips.
      const exportRes = await fetch(`${baseUrl}/api/import/unified/export`);
      assertEq(exportRes.status, 200, 'unified export status = 200');
      const exported = (await exportRes.text()).replace(/^﻿/, '');
      assert(
        exported.split('\n')[0].startsWith('type,'),
        'unified export header starts with "type,"',
      );
      assert(
        exported.includes('[csv-smoke] Studio D'),
        'unified export contains the seeded location',
      );
      assert(
        exported.includes('smoke-unified@test.io'),
        'unified export contains the seeded facilitator',
      );

      // Cleanup
      await prisma.tag.deleteMany({
        where: { organizationId, label: '[csv-smoke] solfege' },
      });
      await prisma.facilitator.deleteMany({
        where: { organizationId, email: 'smoke-unified@test.io' },
      });
      await prisma.location.deleteMany({
        where: { organizationId, name: '[csv-smoke] Studio D' },
      });
    }
  } finally {
    await purgeSmokeData(organizationId);
    server.close();
    console.log('\nTest server stopped.');
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
    await enginePrisma.$disconnect();
  });

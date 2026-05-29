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

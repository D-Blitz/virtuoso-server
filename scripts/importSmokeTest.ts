/**
 * Smoke test for the CSV bulk-import pipeline.
 *
 * Spins up an Express app with the import routes, drives preview +
 * commit via real HTTP fetch calls across the 11 entity types,
 * asserts:
 *   - preview catches invalid rows + counts them
 *   - commit creates new rows, updates re-runs, surfaces row errors
 *   - re-running the same CSV updates instead of duplicating
 *   - m2m relations round-trip through export
 *   - lenient relations (m2m / optional FK misses) become warnings
 *   - composite-key upsert on entities without @@unique
 *   - event ↔ enrollment linkage
 *   - auto-event-generation on enrollment commit (frequency-aware)
 *   - service-default fallback on duration / price
 *   - non-weekly frequencies (BIWEEKLY / CUSTOM) + pricing rename
 *
 * Uses dev-auth-bypass: NODE_ENV != 'production' + DEV_AUTH_BYPASS=true
 * + DEV_DEFAULT_ORG_ID.
 *
 * Usage:
 *   npx ts-node scripts/importSmokeTest.ts [organizationId]
 */
import express from 'express';
import 'dotenv/config';
import Papa from 'papaparse';

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

/**
 * Create-or-skip helper for smoke seeds. Client doesn't have an
 * @@unique(organizationId, email) constraint so `upsert` with that
 * composite throws "Unknown argument" — we hand-roll find-then-create.
 */
async function ensureClient(
  organizationId: string,
  data: {
    email: string;
    firstname: string;
    lastname: string;
    phone: string;
  },
): Promise<void> {
  const existing = await prisma.client.findFirst({
    where: { organizationId, email: data.email },
    select: { id: true },
  });
  if (existing) return;
  await prisma.client.create({
    data: {
      organizationId,
      email: data.email,
      firstname: data.firstname,
      lastname: data.lastname,
      phone: data.phone,
      birthdate: new Date('2010-01-01'),
      address: 'test',
    },
  });
}

async function purgeSmokeData(organizationId: string) {
  // ScheduledEvents reference room + service + facilitator + sometimes
  // enrollment, so they must be hard-deleted first to clear the FK
  // chain before we can delete the seeded dependencies.
  await prisma.scheduledEvent.deleteMany({
    where: {
      organizationId,
      OR: [
        { room: { name: { startsWith: '[csv-smoke]' } } },
        { enrollment: { term: { name: { startsWith: '[csv-smoke]' } } } },
      ],
    },
  });
  await prisma.enrollment.deleteMany({
    where: {
      organizationId,
      OR: [
        { term: { name: { startsWith: '[csv-smoke]' } } },
        { client: { email: { startsWith: 'smoke-evt-cli' } } },
      ],
    },
  });
  await prisma.term.deleteMany({
    where: {
      organizationId,
      name: { startsWith: '[csv-smoke]' },
    },
  });
  await prisma.facilitator.deleteMany({
    where: {
      organizationId,
      email: {
        in: [
          'smoke-csv-1@test.io',
          'smoke-csv-2@test.io',
          'smoke-rel@test.io',
          'smoke-evt-fac@test.io',
        ],
      },
    },
  });
  await prisma.client.deleteMany({
    where: {
      organizationId,
      email: {
        in: [
          'smoke-evt-cli1@test.io',
          'smoke-evt-cli2@test.io',
          'smoke-evt-cli-bi@test.io',
          'smoke-evt-cli-cu@test.io',
          'smoke-evt-cli-ps@test.io',
        ],
      },
    },
  });
  await prisma.room.deleteMany({
    where: { organizationId, name: { startsWith: '[csv-smoke]' } },
  });
  await prisma.service.deleteMany({
    where: { organizationId, name: { startsWith: '[csv-smoke]' } },
  });
  await prisma.serviceCategory.deleteMany({
    where: { organizationId, name: { startsWith: '[csv-smoke]' } },
  });
  await prisma.tag.deleteMany({
    where: {
      organizationId,
      label: { in: ['[csv-smoke] piano', '[csv-smoke] débutant'] },
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
      '[csv-smoke] Studio B,2 rue Test,',
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
      where: { organizationId, name: { startsWith: '[csv-smoke]' } },
    });
    assertEq(locsInDb.length, 2, 'exactly 2 smoke locations in DB after re-run');

    // ── 3b. Semicolon-delimited CSV (European Excel export) ──
    console.log('\n3b. Semicolon-delimited CSV is accepted');
    const semiCsv = [
      'name;address;description',
      // The unquoted comma inside `address` is the real assertion here:
      // it only survives if the delimiter actually switched to ';'.
      // Parsed as ',' this row would split into 4 fields and land the
      // wrong value in `description`.
      '[csv-smoke] Studio A;1 rue Test, Bâtiment B;Petite salle',
      '[csv-smoke] Studio B;2 rue Test;',
    ].join('\n');
    {
      const r = await postCsv('/api/import/preview/location', semiCsv);
      assertEq(r.json.totalRows, 2, 'semicolon preview: 2 rows');
      assertEq(r.json.validRows, 2, 'semicolon preview: 2 valid');
      assertEq(r.json.errorRows, 0, 'semicolon preview: 0 errors');
    }
    {
      const r = await postCsv('/api/import/commit/location', semiCsv);
      assertEq(r.json.created, 0, 'semicolon commit: 0 created (upserts)');
      assertEq(r.json.updated, 2, 'semicolon commit: 2 updated');
    }
    const semiLoc = await prisma.location.findFirst({
      where: { organizationId, name: '[csv-smoke] Studio A' },
      select: { address: true, description: true },
    });
    assertEq(
      semiLoc?.address,
      '1 rue Test, Bâtiment B',
      'comma inside a semicolon-delimited cell survives intact',
    );
    assertEq(
      semiLoc?.description,
      'Petite salle',
      'following column not shifted by the embedded comma',
    );

    // Single-column files have no delimiter to find — must still fall
    // back to ',' rather than erroring (the original reason auto-detect
    // was rejected).
    {
      const r = await postCsv(
        '/api/import/preview/tag',
        ['label', '[csv-smoke] piano'].join('\n'),
      );
      assertEq(r.json.totalRows, 1, 'single-column CSV: 1 row');
      assertEq(r.json.errorRows, 0, 'single-column CSV: still parses');
    }

    // ── 3c. Explicit ?delimiter= overrides detection ─────────
    console.log('\n3c. Explicit separator overrides detection');
    // Pipe-delimited. Detection only knows ',' and ';', so it falls
    // back to ',' and sees one giant column — this row can only import
    // if the explicit override is actually honoured.
    const pipeCsv = [
      'name|address|description',
      '[csv-smoke] Studio A|1 rue Test|Salle pipe',
    ].join('\n');
    {
      const auto = await postCsv('/api/import/preview/location', pipeCsv);
      assertEq(auto.json.errorRows, 1, 'pipe file, no override: row errors');
    }
    {
      const r = await postCsv(
        `/api/import/preview/location?delimiter=${encodeURIComponent('|')}`,
        pipeCsv,
      );
      assertEq(r.json.validRows, 1, 'pipe file, override: 1 valid');
      assertEq(r.json.errorRows, 0, 'pipe file, override: 0 errors');
    }

    // Invalid separators are refused rather than silently coerced.
    {
      const r = await postCsv(
        `/api/import/preview/location?delimiter=${encodeURIComponent('"')}`,
        locCsv,
      );
      assertEq(r.status, 400, 'double-quote separator rejected');
    }
    {
      const r = await postCsv(
        '/api/import/preview/location?delimiter=ab',
        locCsv,
      );
      assertEq(r.status, 400, 'multi-character separator rejected');
    }

    // ── 3d. Download honours the chosen separator ────────────
    console.log('\n3d. Template + export honour the chosen separator');
    {
      const res = await fetch(
        `${baseUrl}/api/import/template/location?delimiter=${encodeURIComponent(';')}`,
      );
      assertEq(res.status, 200, 'template with ";" status = 200');
      const header = (await res.text())
        .replace(/^﻿/, '')
        .split('\n')[0];
      assert(
        header.startsWith('name;address'),
        'template header uses the chosen separator',
      );
    }
    {
      // Full journey: export as ';', then re-upload with detection on.
      const res = await fetch(
        `${baseUrl}/api/import/export/location?delimiter=${encodeURIComponent(';')}`,
      );
      const csv = (await res.text()).replace(/^﻿/, '');
      assert(
        csv.split('\n')[0].startsWith('name;address'),
        'export header uses the chosen separator',
      );
      const reimport = await postCsv('/api/import/commit/location', csv);
      assertEq(reimport.json.created, 0, '";" export re-imports: 0 created');
      assert(
        reimport.json.updated >= 2,
        '";" export re-imports: ≥2 updated',
      );
    }

    // ── 4. Facilitator: relation-free import ────────────────
    console.log('\n4. Facilitator preview + commit');
    const facCsv = [
      'firstname,lastname,email,phone,color,isBookable',
      'Alice,Smoke,smoke-csv-1@test.io,5555550101,#5b5bff,oui',
      'Bob,Smoke,smoke-csv-2@test.io,5555550102,#fa8072,oui',
      'Charlie,Smoke,not-an-email,5555550103,not-a-color,oui',
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
        errRow.errors.some((e: string) => e.toLowerCase().includes('couleur')),
        'invalid-row reports color error',
      );
    }
    {
      const commit = await postCsv('/api/import/commit/facilitator', facCsv);
      assertEq(commit.json.created, 2, '2 facilitators created');
      assertEq(commit.json.errored, 1, '1 facilitator row errored');
    }

    // ── 4b. Facilitator with m2m relations (locations + tags) ─
    console.log('\n4b. Facilitator with m2m relations');
    {
      const tagCsv = [
        'label',
        '[csv-smoke] piano',
        '[csv-smoke] débutant',
      ].join('\n');
      const tagCommit = await postCsv('/api/import/commit/tag', tagCsv);
      assertEq(tagCommit.json.errored, 0, 'tag seed: 0 errored');
    }
    const relCsv = [
      'firstname,lastname,email,phone,color,isBookable,locations,tags',
      [
        'Rel',
        'Smoke',
        'smoke-rel@test.io',
        '5555550104',
        '#33aa33',
        'oui',
        '"[csv-smoke] Studio A, [csv-smoke] Studio B"',
        '"[csv-smoke] piano, [csv-smoke] débutant"',
      ].join(','),
    ].join('\n');
    {
      const commit = await postCsv('/api/import/commit/facilitator', relCsv);
      assertEq(commit.json.created, 1, 'relations row: 1 created');
      assertEq(commit.json.errored, 0, 'relations row: 0 errored');
    }
    const facWithRels = await prisma.facilitator.findFirst({
      where: { organizationId, email: 'smoke-rel@test.io' },
      select: {
        locations: { select: { name: true } },
        tags: { select: { label: true } },
      },
    });
    assertEq(facWithRels?.locations.length ?? 0, 2, 'fac has 2 locations linked');
    assertEq(facWithRels?.tags.length ?? 0, 2, 'fac has 2 tags linked');

    // ── 4c. Missing m2m target → warning (not error) ──────────
    console.log('\n4c. Missing m2m target → warning');
    await prisma.facilitator.deleteMany({
      where: { organizationId, email: 'smoke-rel@test.io' },
    });
    const warnCsv = [
      'firstname,lastname,email,phone,color,isBookable,locations',
      [
        'Rel',
        'Smoke',
        'smoke-rel@test.io',
        '5555550104',
        '#33aa33',
        'oui',
        '"[csv-smoke] Studio A, [csv-smoke] DOES NOT EXIST"',
      ].join(','),
    ].join('\n');
    {
      const preview = await postCsv('/api/import/preview/facilitator', warnCsv);
      assertEq(preview.json.errorRows, 0, 'warn preview: 0 errors');
      assertEq(preview.json.warningRows, 1, 'warn preview: 1 warning');
      const row = preview.json.rows[0];
      assert(
        row.warnings.some((w: string) => w.includes('DOES NOT EXIST')),
        'warning mentions the missing target name',
      );
    }
    {
      const commit = await postCsv('/api/import/commit/facilitator', warnCsv);
      assertEq(commit.json.warned, 1, 'warn commit: 1 warned');
      assertEq(commit.json.created, 1, 'warn commit: 1 created');
    }
    const partial = await prisma.facilitator.findFirst({
      where: { organizationId, email: 'smoke-rel@test.io' },
      select: { locations: { select: { name: true } } },
    });
    assertEq(partial?.locations.length ?? 0, 1, 'attached only the existing location');

    // ── 4d. ScheduledEvent import + composite-key upsert ────
    console.log('\n4d. ScheduledEvent import + composite-key upsert');
    {
      const catCsv = [
        'name,description',
        '[csv-smoke] Piano,Cours de piano',
      ].join('\n');
      const c = await postCsv('/api/import/commit/serviceCategory', catCsv);
      assertEq(c.json.errored, 0, 'event seed: category 0 errored');

      const svcCsv = [
        'name,description,category,defaultDurationMinutes,defaultPrice',
        '[csv-smoke] Piano 30min,Cours individuel,[csv-smoke] Piano,30,35',
      ].join('\n');
      const s = await postCsv('/api/import/commit/service', svcCsv);
      assertEq(s.json.errored, 0, 'event seed: service 0 errored');

      const roomCsv = [
        'name,location,color',
        '[csv-smoke] Salle A,[csv-smoke] Studio A,#5b5bff',
      ].join('\n');
      const r = await postCsv('/api/import/commit/room', roomCsv);
      assertEq(r.json.errored, 0, 'event seed: room 0 errored');

      const facSeed = [
        'firstname,lastname,email,phone,color',
        'Eve,Smoke,smoke-evt-fac@test.io,5555550200,#33aa33',
      ].join('\n');
      const f = await postCsv('/api/import/commit/facilitator', facSeed);
      assertEq(f.json.errored, 0, 'event seed: facilitator 0 errored');

      const cliCsv = [
        'firstname,lastname,email,phone,birthdate,address',
        'Sam,Smoke,smoke-evt-cli1@test.io,5550300,2010-01-01,1 rue Test',
        'Lou,Smoke,smoke-evt-cli2@test.io,5550301,2011-02-02,2 rue Test',
      ].join('\n');
      const cl = await postCsv('/api/import/commit/client', cliCsv);
      assertEq(cl.json.errored, 0, 'event seed: client 0 errored');
    }
    const evtCsv = [
      'date,startTime,endTime,service,room,facilitators,clients,color,price,notes,tags',
      [
        '2026-09-15',
        '14:00',
        '15:00',
        '[csv-smoke] Piano 30min',
        '[csv-smoke] Salle A',
        'smoke-evt-fac@test.io',
        '"smoke-evt-cli1@test.io, smoke-evt-cli2@test.io"',
        '#5b5bff',
        '35.00',
        '',
        '"[csv-smoke] piano"',
      ].join(','),
      [
        '2026-09-15',
        '15:00',
        '16:00',
        '[csv-smoke] Piano 30min',
        '[csv-smoke] Salle A',
        'smoke-evt-fac@test.io',
        'smoke-evt-cli1@test.io',
        '#5b5bff',
        '35.00',
        '',
        '',
      ].join(','),
      [
        '2026-09-22',
        '14:00',
        '15:00',
        'Does Not Exist',
        '[csv-smoke] Salle A',
        'smoke-evt-fac@test.io',
        '',
        '#5b5bff',
        '35.00',
        '',
        '',
      ].join(','),
    ].join('\n');
    {
      const commit = await postCsv('/api/import/commit/scheduledEvent', evtCsv);
      assertEq(commit.json.created, 2, 'event commit: 2 created');
      assertEq(commit.json.errored, 1, 'event commit: 1 errored');
    }
    const firstEvt = await prisma.scheduledEvent.findFirst({
      where: {
        organizationId,
        startTime: new Date('2026-09-15T14:00:00'),
        room: { name: '[csv-smoke] Salle A' },
      },
      select: {
        location: { select: { name: true } },
        serviceCategory: { select: { name: true } },
        clients: { select: { email: true } },
      },
    });
    assertEq(firstEvt?.location.name, '[csv-smoke] Studio A', 'derived locationId');
    assertEq(
      firstEvt?.serviceCategory.name,
      '[csv-smoke] Piano',
      'derived serviceCategoryId',
    );
    assertEq(firstEvt?.clients.length ?? 0, 2, '2 clients linked');

    // Re-import: composite-key upsert.
    {
      const recommit = await postCsv('/api/import/commit/scheduledEvent', evtCsv);
      assertEq(recommit.json.updated, 2, 'event re-import: 2 updated');
      assertEq(recommit.json.created, 0, 'event re-import: 0 created');
    }

    // ── 4e. Enrollment import + auto-event-generation ───────
    console.log('\n4e. Enrollment import + auto-event-generation');
    {
      const termCsv = [
        'name,startDate,endDate',
        '[csv-smoke] Trimestre,2026-09-01,2026-12-19',
      ].join('\n');
      const t = await postCsv('/api/import/commit/term', termCsv);
      assertEq(t.json.errored, 0, 'term seed: 0 errored');
    }
    const enrCsv = [
      'client,service,term,room,facilitator,weekday,startTime,durationMinutes,startDate,endDate,priceCharged,pricingStrategy,status',
      [
        'smoke-evt-cli1@test.io',
        '[csv-smoke] Piano 30min',
        '[csv-smoke] Trimestre',
        '[csv-smoke] Salle A',
        'smoke-evt-fac@test.io',
        'mardi',
        '17:00',
        '60',
        '2026-09-15',
        '2026-12-15',
        '350.00',
        'PERIOD_PRORATED',
        'ACTIVE',
      ].join(','),
    ].join('\n');
    {
      const c = await postCsv('/api/import/commit/enrollment', enrCsv);
      assertEq(c.json.created, 1, 'enrollment: 1 created');
      assertEq(c.json.errored, 0, 'enrollment: 0 errored');
    }
    const enrInDb = await prisma.enrollment.findFirst({
      where: {
        organizationId,
        term: { name: '[csv-smoke] Trimestre' },
        client: { email: 'smoke-evt-cli1@test.io' },
      },
      select: {
        id: true,
        frequency: true,
        weekday: true,
        events: { select: { id: true } },
      },
    });
    assert(enrInDb != null, 'enrollment exists in DB');
    assertEq(enrInDb?.frequency, 'WEEKLY', 'default frequency = WEEKLY');
    assertEq(enrInDb?.weekday, 2, 'weekday = 2 (mardi)');
    assert(
      (enrInDb?.events.length ?? 0) >= 10,
      'auto-gen produced ≥10 weekly events',
    );

    // ── 4e.i — Empty duration/price fall back to service ─────
    console.log('\n4e.i Service-default fallback');
    const fallbackCsv = [
      'client,service,term,room,facilitator,weekday,startTime,durationMinutes,startDate,endDate,priceCharged,pricingStrategy,status',
      [
        'smoke-evt-cli2@test.io',
        '[csv-smoke] Piano 30min',
        '[csv-smoke] Trimestre',
        '[csv-smoke] Salle A',
        'smoke-evt-fac@test.io',
        'mercredi',
        '18:00',
        '', // empty → service default
        '2026-09-15',
        '2026-12-15',
        '', // empty → service default
        'PERIOD_PRORATED',
        'ACTIVE',
      ].join(','),
    ].join('\n');
    {
      const c = await postCsv('/api/import/commit/enrollment', fallbackCsv);
      assertEq(c.json.created, 1, 'fallback: 1 created');
      assertEq(c.json.errored, 0, 'fallback: 0 errored');
    }
    const fb = await prisma.enrollment.findFirst({
      where: {
        organizationId,
        client: { email: 'smoke-evt-cli2@test.io' },
      },
      select: { durationMinutes: true, priceCharged: true },
    });
    assertEq(fb?.durationMinutes, 30, 'duration inherited (30)');
    assertEq(fb?.priceCharged, 35, 'price inherited (35)');

    // ── 4e.ii — BIWEEKLY + CUSTOM + pricing rename ──────────
    console.log('\n4e.ii Non-weekly frequencies + pricing rename');
    // BIWEEKLY
    await ensureClient(organizationId, {
      email: 'smoke-evt-cli-bi@test.io',
      firstname: 'Bi',
      lastname: 'Weekly',
      phone: '5559990001',
    });
    const biCsv = [
      'client,service,term,room,facilitator,frequency,weekday,startTime,durationMinutes,startDate,endDate,priceCharged,pricingStrategy,status',
      [
        'smoke-evt-cli-bi@test.io',
        '[csv-smoke] Piano 30min',
        '[csv-smoke] Trimestre',
        '[csv-smoke] Salle A',
        'smoke-evt-fac@test.io',
        'BIWEEKLY',
        'mardi',
        '19:00',
        '60',
        '2026-09-15',
        '2026-12-15',
        '',
        'PERIOD_PRORATED',
        'ACTIVE',
      ].join(','),
    ].join('\n');
    {
      const c = await postCsv('/api/import/commit/enrollment', biCsv);
      assertEq(c.json.created, 1, 'BIWEEKLY: 1 created');
    }
    const bi = await prisma.enrollment.findFirst({
      where: {
        organizationId,
        client: { email: 'smoke-evt-cli-bi@test.io' },
      },
      select: {
        frequency: true,
        weekday: true,
        events: { select: { id: true } },
      },
    });
    assertEq(bi?.frequency, 'BIWEEKLY', 'BIWEEKLY stored');
    assertEq(bi?.weekday, 2, 'BIWEEKLY weekday stored');
    assert(
      (bi?.events.length ?? 0) >= 5 && (bi?.events.length ?? 0) <= 8,
      'BIWEEKLY produced ~6 events',
    );

    // CUSTOM
    await ensureClient(organizationId, {
      email: 'smoke-evt-cli-cu@test.io',
      firstname: 'Custom',
      lastname: 'Dates',
      phone: '5559990002',
    });
    const cuCsv = [
      'client,service,term,room,facilitator,frequency,weekday,startTime,durationMinutes,startDate,endDate,customDates,priceCharged,pricingStrategy,status',
      [
        'smoke-evt-cli-cu@test.io',
        '[csv-smoke] Piano 30min',
        '[csv-smoke] Trimestre',
        '[csv-smoke] Salle A',
        'smoke-evt-fac@test.io',
        'CUSTOM',
        '',
        '20:00',
        '45',
        '2026-09-15',
        '2026-12-15',
        '"2026-09-20T20:00:00|2026-10-04T20:00:00|2026-11-15T20:00:00"',
        '',
        'PERIOD_PRORATED',
        'ACTIVE',
      ].join(','),
    ].join('\n');
    {
      const c = await postCsv('/api/import/commit/enrollment', cuCsv);
      assertEq(c.json.created, 1, 'CUSTOM: 1 created');
    }
    const cu = await prisma.enrollment.findFirst({
      where: {
        organizationId,
        client: { email: 'smoke-evt-cli-cu@test.io' },
      },
      select: {
        frequency: true,
        weekday: true,
        customDates: true,
        events: { select: { id: true } },
      },
    });
    assertEq(cu?.frequency, 'CUSTOM', 'CUSTOM stored');
    assertEq(cu?.weekday, null, 'weekday null for CUSTOM');
    assertEq(
      Array.isArray(cu?.customDates) ? (cu?.customDates as string[]).length : 0,
      3,
      'customDates stores 3 entries',
    );
    assertEq(cu?.events.length ?? 0, 3, 'CUSTOM auto-gen: 3 events');

    // Pricing rename: PERIOD_FIXED stores verbatim
    await ensureClient(organizationId, {
      email: 'smoke-evt-cli-ps@test.io',
      firstname: 'Pricing',
      lastname: 'Strategy',
      phone: '5559990003',
    });
    const psCsv = [
      'client,service,term,room,frequency,weekday,startTime,durationMinutes,startDate,endDate,priceCharged,pricingStrategy,status',
      [
        'smoke-evt-cli-ps@test.io',
        '[csv-smoke] Piano 30min',
        '[csv-smoke] Trimestre',
        '[csv-smoke] Salle A',
        'WEEKLY',
        'lundi',
        '17:00',
        '60',
        '2026-09-15',
        '2026-12-15',
        '350',
        'PERIOD_FIXED',
        'ACTIVE',
      ].join(','),
    ].join('\n');
    {
      const c = await postCsv('/api/import/commit/enrollment', psCsv);
      assertEq(c.json.created, 1, 'pricing rename: 1 created');
    }
    const ps = await prisma.enrollment.findFirst({
      where: {
        organizationId,
        client: { email: 'smoke-evt-cli-ps@test.io' },
      },
      select: { pricingStrategy: true },
    });
    assertEq(
      ps?.pricingStrategy,
      'PERIOD_FIXED',
      'new pricing strategy value stored',
    );

    // ── 4f. Event ↔ enrollment linkage ───────────────────────
    console.log('\n4f. Event with enrollment-column linkage');
    const linkedEvtCsv = [
      'date,startTime,endTime,service,room,facilitators,clients,color,price,notes,tags,enrollment',
      [
        '2026-09-22',
        '17:00',
        '18:00',
        '[csv-smoke] Piano 30min',
        '[csv-smoke] Salle A',
        'smoke-evt-fac@test.io',
        'smoke-evt-cli1@test.io',
        '#5b5bff',
        '0',
        '',
        '',
        'smoke-evt-cli1@test.io|[csv-smoke] Trimestre|[csv-smoke] Piano 30min',
      ].join(','),
    ].join('\n');
    {
      const c = await postCsv('/api/import/commit/scheduledEvent', linkedEvtCsv);
      assertEq(c.json.errored, 0, 'linked event: 0 errored');
    }
    const linkedEvt = await prisma.scheduledEvent.findFirst({
      where: {
        organizationId,
        startTime: new Date('2026-09-22T17:00:00'),
        room: { name: '[csv-smoke] Salle A' },
      },
      select: { enrollmentId: true },
    });
    assertEq(
      linkedEvt?.enrollmentId,
      enrInDb!.id,
      'event linked to enrollment',
    );

    // Bad composite = warning, not error
    const badLinkedCsv = [
      'date,startTime,endTime,service,room,facilitators,clients,color,price,notes,tags,enrollment',
      [
        '2026-09-29',
        '09:00',
        '10:00',
        '[csv-smoke] Piano 30min',
        '[csv-smoke] Salle A',
        'smoke-evt-fac@test.io',
        '',
        '#5b5bff',
        '0',
        '',
        '',
        'unknown@example.com|nonexistent|nonexistent',
      ].join(','),
    ].join('\n');
    {
      const preview = await postCsv(
        '/api/import/preview/scheduledEvent',
        badLinkedCsv,
      );
      assertEq(preview.json.warningRows, 1, 'bad-link: 1 warning');
      assertEq(preview.json.errorRows, 0, 'bad-link: 0 errors');
    }

    // ── 5. Template endpoint ─────────────────────────────────
    console.log('\n5. Template endpoint returns headers + example');
    {
      const res = await fetch(`${baseUrl}/api/import/template/facilitator`);
      assertEq(res.status, 200, 'template status = 200');
      const text = await res.text();
      const headerLine = text.split('\n')[0].replace(/^﻿/, '');
      assert(headerLine.includes('email'), 'template includes email column');
      assert(headerLine.includes('firstname'), 'template includes firstname');

      // The availability example is the one cell admins copy verbatim,
      // and it contains both quotes and commas — assert it survives CSV
      // escaping and still parses into the { weekday: [{start, end}] }
      // shape the availability service reads.
      const templateRows = Papa.parse<Record<string, string>>(
        text.replace(/^﻿/, ''),
        { header: true, skipEmptyLines: 'greedy' },
      ).data;
      let avail: unknown = null;
      try {
        avail = JSON.parse(templateRows[0]?.availability ?? '');
      } catch {
        avail = null;
      }
      assert(
        avail != null,
        'availability example is valid JSON after CSV round-trip',
      );
      const firstDay =
        avail && typeof avail === 'object'
          ? Object.values(avail as Record<string, unknown>)[0]
          : null;
      const firstWindow = Array.isArray(firstDay)
        ? (firstDay[0] as { start?: unknown; end?: unknown })
        : null;
      assert(
        typeof firstWindow?.start === 'string' &&
          typeof firstWindow?.end === 'string',
        'availability example uses { start, end } windows',
      );
    }

    // ── 6. Registry endpoint lists all entities ──────────────
    console.log('\n6. Registry endpoint surfaces all importable entities');
    {
      const res = await fetch(`${baseUrl}/api/import/registry`);
      const body = (await res.json()) as { entities: { type: string }[] };
      assertEq(res.status, 200, 'registry status = 200');
      assertEq(body.entities.length, 11, 'registry returns 11 entities');
      const types = new Set(body.entities.map((e) => e.type));
      [
        'location',
        'facilitator',
        'service',
        'room',
        'tag',
        'serviceCategory',
        'term',
        'closure',
        'client',
        'enrollment',
        'scheduledEvent',
      ].forEach((t) => {
        assert(types.has(t), `registry includes "${t}"`);
      });
    }

    // ── 7. Export round-trip ─────────────────────────────────
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

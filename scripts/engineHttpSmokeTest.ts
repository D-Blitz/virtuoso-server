/**
 * Engine HTTP smoke test — Phase 2.0 Commit 3.
 *
 * Spins up an Express app that mounts the same routes as src/index.ts
 * (minus the background jobs), drives both the admin CRUD surface and
 * the public visitor surface via real HTTP fetch calls, and asserts
 * end-to-end behavior — including the auth gate, draft autosave,
 * publish validation, JSON export/import round-trip, and the public
 * run lifecycle through `requireWidgetFlow`.
 *
 * Uses the existing dev-auth-bypass mechanism in `requireUser`:
 * NODE_ENV != 'production' + DEV_AUTH_BYPASS=true + DEV_DEFAULT_ORG_ID
 * grants every permission for the duration of the test. The bypass
 * is process-local; this script exits when done.
 *
 * Usage:
 *   npx ts-node scripts/engineHttpSmokeTest.ts [organizationId]
 *
 * Exit codes:
 *   0  all assertions passed
 *   1  any assertion failed or unexpected error
 */
import express from 'express';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';

import { PrismaClient } from '@prisma/client';

import { requireUser } from '../src/middleware/auth';
import publicWidgetFlowRoutes from '../src/routes/publicWidgetFlow.routes';
import widgetFlowRoutes from '../src/routes/widgetFlow.routes';
import enginePrisma from '../src/prisma';

const prisma = new PrismaClient();

// ─── Assertion harness ────────────────────────────────────────────

let assertionCount = 0;
let failureCount = 0;

function assert(condition: unknown, label: string): void {
  assertionCount += 1;
  if (!condition) {
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

// ─── HTTP helper ──────────────────────────────────────────────────

let baseUrl = '';

async function http(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any; raw: string }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  let json: any = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = { _parseError: raw.slice(0, 200) };
  }
  return { status: res.status, json, raw };
}

// ─── Server harness ───────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  // Public routes (no requireUser).
  app.use('/api/public/widget-flows', publicWidgetFlowRoutes);
  // Admin routes — gated by requireUser, which honors the dev bypass.
  app.use('/api', requireUser);
  app.use('/api/widget-flows', widgetFlowRoutes);
  return app;
}

// ─── Fixture cleanup ──────────────────────────────────────────────

async function purgeSmokeFlows(organizationId: string) {
  const flows = await prisma.widgetFlow.findMany({
    where: {
      organizationId,
      name: { startsWith: '[http-smoke]' },
    },
    select: { id: true },
  });
  for (const f of flows) {
    await prisma.engineActionEvent.deleteMany({ where: { flowId: f.id } });
    await prisma.widgetRun.deleteMany({ where: { flowId: f.id } });
    await prisma.widgetFlow.delete({ where: { id: f.id } });
  }
  return flows.length;
}

// ─── Main ─────────────────────────────────────────────────────────

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
  console.log(`\nRunning HTTP smoke test against org "${org.name}"\n`);

  // Configure dev-auth-bypass for the admin routes. Setting these env
  // vars in-process is enough because the requireUser middleware reads
  // them at request time, not at import.
  process.env.DEV_AUTH_BYPASS = 'true';
  process.env.DEV_DEFAULT_ORG_ID = organizationId;

  await purgeSmokeFlows(organizationId);

  const app = buildApp();
  const server = app.listen(0); // ephemeral port
  await new Promise<void>((r) => server.on('listening', () => r()));
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://localhost:${port}`;
  console.log(`Test server listening on ${baseUrl}\n`);

  let createdFlowId: string | null = null;
  let publishableKey: string | null = null;

  try {
    // ── Phase 1: admin creates a flow ─────────────────────────
    console.log('1. POST /api/widget-flows — create draft flow');
    {
      const r = await http('POST', '/api/widget-flows', {
        name: '[http-smoke] flow A',
        description: 'Smoke test flow',
        kind: 'BOOKING',
      });
      assertEq(r.status, 201, 'status = 201');
      assert(r.json?.flow?.id, 'flow.id returned');
      assertEq(r.json?.flow?.isPublished, false, 'isPublished = false on create');
      assertEq(r.json?.flow?.publishableKey, null, 'publishableKey = null on create');
      createdFlowId = r.json?.flow?.id;
    }
    if (!createdFlowId) throw new Error('createdFlowId not set, aborting');

    // ── Phase 2: list shows the new flow ──────────────────────
    console.log('\n2. GET /api/widget-flows — list shows new flow');
    {
      const r = await http('GET', '/api/widget-flows');
      assertEq(r.status, 200, 'status = 200');
      assert(
        Array.isArray(r.json?.flows) &&
          r.json.flows.some((f: any) => f.id === createdFlowId),
        'list includes new flow',
      );
    }

    // ── Phase 3: GET detail before any draft ──────────────────
    console.log('\n3. GET /api/widget-flows/:id — detail (no draft yet)');
    {
      const r = await http('GET', `/api/widget-flows/${createdFlowId}`);
      assertEq(r.status, 200, 'status = 200');
      assertEq(r.json?.flow?.steps?.length, 0, 'no steps yet');
    }
    {
      const r = await http('GET', `/api/widget-flows/${createdFlowId}/draft`);
      assertEq(r.status, 200, 'GET draft status = 200');
      assertEq(r.json?.draft, null, 'draft is null before first save');
    }

    // ── Phase 4: PATCH draft — autosave ───────────────────────
    console.log('\n4. PATCH /api/widget-flows/:id/draft — autosave');
    const flowPayload = {
      name: '[http-smoke] flow A',
      description: 'Updated by smoke test',
      kind: 'BOOKING' as const,
      steps: [
        {
          order: 0,
          kind: 'SINGLE_SELECT' as const,
          label: 'Pick an instrument',
          description: null,
          config: {
            varName: 'instrument',
            options: [
              { value: 'piano', label: 'Piano' },
              { value: 'guitar', label: 'Guitare' },
            ],
          },
          visibleWhen: null,
          fields: [],
        },
        {
          order: 1,
          kind: 'FORM' as const,
          label: 'Your contact',
          description: null,
          config: {},
          visibleWhen: null,
          fields: [
            {
              order: 0,
              kind: 'TEXT' as const,
              label: 'Prénom',
              placeholder: null,
              required: true,
              binding: 'VAR' as const,
              bindingTarget: 'firstname',
              config: {},
            },
            {
              order: 1,
              kind: 'EMAIL' as const,
              label: 'Email',
              placeholder: null,
              required: true,
              binding: 'VAR' as const,
              bindingTarget: 'email',
              config: {},
            },
          ],
        },
        {
          order: 2,
          kind: 'RECAP' as const,
          label: 'Confirmation',
          description: null,
          config: {},
          visibleWhen: null,
          fields: [],
        },
      ],
    };
    {
      const r = await http(
        'PATCH',
        `/api/widget-flows/${createdFlowId}/draft`,
        flowPayload,
      );
      assertEq(r.status, 200, 'PATCH draft status = 200');
      assert(r.json?.draft?.updatedAt, 'draft.updatedAt returned');
    }
    {
      const r = await http('GET', `/api/widget-flows/${createdFlowId}/draft`);
      assertEq(r.status, 200, 'GET draft status = 200 after save');
      assertEq(r.json?.draft?.steps?.length, 3, 'draft has 3 steps');
    }

    // ── Phase 5: publish ──────────────────────────────────────
    console.log('\n5. POST /api/widget-flows/:id/publish');
    {
      const r = await http('POST', `/api/widget-flows/${createdFlowId}/publish`);
      assertEq(r.status, 200, 'publish status = 200');
      assertEq(r.json?.flow?.isPublished, true, 'isPublished = true');
      assertEq(r.json?.flow?.version, 2, 'version bumped to 2');
      assert(
        typeof r.json?.flow?.publishableKey === 'string' &&
          r.json.flow.publishableKey.startsWith('wf_'),
        'publishableKey assigned (wf_ prefix)',
      );
      assertEq(r.json?.flow?.steps?.length, 3, 'normalized steps written');
      publishableKey = r.json.flow.publishableKey;
    }

    // ── Phase 6: publish blocked by validation ────────────────
    console.log('\n6. Publish blocked when draft is invalid');
    {
      // Save a draft with no steps — should be blocked.
      await http('PATCH', `/api/widget-flows/${createdFlowId}/draft`, {
        name: '[http-smoke] flow A',
        description: null,
        kind: 'BOOKING' as const,
        steps: [],
      });
      const r = await http(
        'POST',
        `/api/widget-flows/${createdFlowId}/publish`,
      );
      assertEq(r.status, 422, 'publish blocked status = 422');
      assertEq(r.json?.code, 'PUBLISH_BLOCKED', 'code = PUBLISH_BLOCKED');
      assert(
        Array.isArray(r.json?.issues) && r.json.issues.length > 0,
        'issues array returned',
      );
    }
    // Restore the good draft + republish so subsequent phases work.
    await http('PATCH', `/api/widget-flows/${createdFlowId}/draft`, flowPayload);
    await http('POST', `/api/widget-flows/${createdFlowId}/publish`);

    // ── Phase 7: export round-trips ───────────────────────────
    console.log('\n7. GET /api/widget-flows/:id/export');
    let exportedPayload: any = null;
    {
      const r = await http('GET', `/api/widget-flows/${createdFlowId}/export`);
      assertEq(r.status, 200, 'export status = 200');
      assertEq(r.json?.kind, 'BOOKING', 'export.kind preserved');
      assertEq(r.json?.steps?.length, 3, 'export has 3 steps');
      exportedPayload = r.json;
    }

    // ── Phase 8: import creates a new flow ────────────────────
    console.log('\n8. POST /api/widget-flows/import');
    let importedFlowId: string | null = null;
    {
      const importBody = {
        ...exportedPayload,
        name: '[http-smoke] imported flow',
      };
      const r = await http('POST', '/api/widget-flows/import', importBody);
      assertEq(r.status, 201, 'import status = 201');
      assert(r.json?.flow?.id, 'imported flow.id returned');
      assert(
        r.json?.flow?.id !== createdFlowId,
        'imported flow has different id',
      );
      assertEq(
        r.json?.flow?.isPublished,
        false,
        'imported flow is NOT published',
      );
      assertEq(r.json?.flow?.steps?.length, 3, 'imported flow has 3 steps');
      importedFlowId = r.json.flow.id;
    }

    // ── Phase 9: public visitor walks the published flow ──────
    console.log('\n9. Public flow run via :publishableKey');
    if (!publishableKey) throw new Error('publishableKey not set');

    let runId: string | null = null;
    let firstStepId: string | null = null;
    {
      const r = await http(
        'POST',
        `/api/public/widget-flows/by-key/${publishableKey}/runs`,
        {},
      );
      assertEq(r.status, 201, 'createRun status = 201');
      assert(r.json?.run?.id, 'run.id returned');
      assertEq(r.json?.run?.status, 'IN_PROGRESS', 'status = IN_PROGRESS');
      assertEq(
        r.json?.firstStep?.kind,
        'SINGLE_SELECT',
        'firstStep.kind = SINGLE_SELECT',
      );
      // Public response MUST NOT leak organizationId.
      assertEq(
        (r.json?.run as Record<string, unknown>)?.organizationId,
        undefined,
        'public run does NOT leak organizationId',
      );
      runId = r.json.run.id;
      firstStepId = r.json.firstStep.id;
    }
    if (!runId || !firstStepId) throw new Error('runId/firstStepId not set');

    // submit step 1 (SINGLE_SELECT)
    const submit1Id = randomUUID();
    {
      const r = await http(
        'POST',
        `/api/public/widget-flows/by-key/${publishableKey}/runs/${runId}/steps/${firstStepId}/submit`,
        { values: { selected: 'piano' }, clientSubmitId: submit1Id },
      );
      assertEq(r.status, 200, 'submit step 1 status = 200');
      assertEq(r.json?.errors?.length, 0, 'no errors');
      assertEq(r.json?.replayed, false, 'not replayed');
      assert(r.json?.nextStep?.id, 'nextStep returned');
    }

    // idempotent replay of step 1
    {
      const r = await http(
        'POST',
        `/api/public/widget-flows/by-key/${publishableKey}/runs/${runId}/steps/${firstStepId}/submit`,
        { values: { selected: 'piano' }, clientSubmitId: submit1Id },
      );
      assertEq(r.status, 200, 'replay status = 200');
      assertEq(r.json?.replayed, true, 'replayed = true');
    }

    // submit FORM with invalid email
    const formStepId: string = (
      await http(
        'GET',
        `/api/public/widget-flows/by-key/${publishableKey}/runs/${runId}`,
      )
    ).json?.currentStep?.id;
    {
      const r = await http(
        'POST',
        `/api/public/widget-flows/by-key/${publishableKey}/runs/${runId}/steps/${formStepId}/submit`,
        {
          values: { firstname: 'A', email: 'not-an-email' },
          clientSubmitId: randomUUID(),
        },
      );
      assertEq(r.status, 200, 'FORM submit returns 200 even with errors');
      assert(r.json?.errors?.length > 0, 'FORM returns validation errors');
    }

    // submit FORM valid → RECAP
    {
      const r = await http(
        'POST',
        `/api/public/widget-flows/by-key/${publishableKey}/runs/${runId}/steps/${formStepId}/submit`,
        {
          values: { firstname: 'Alice', email: 'alice@example.com' },
          clientSubmitId: randomUUID(),
        },
      );
      assertEq(r.status, 200, 'FORM valid submit status = 200');
      assertEq(r.json?.errors?.length, 0, 'no errors');
      assertEq(r.json?.nextStep?.kind, 'RECAP', 'nextStep = RECAP');
    }

    // submit RECAP → COMPLETED
    const recapStepId: string = (
      await http(
        'GET',
        `/api/public/widget-flows/by-key/${publishableKey}/runs/${runId}`,
      )
    ).json?.currentStep?.id;
    {
      const r = await http(
        'POST',
        `/api/public/widget-flows/by-key/${publishableKey}/runs/${runId}/steps/${recapStepId}/submit`,
        { values: {}, clientSubmitId: randomUUID() },
      );
      assertEq(r.status, 200, 'RECAP submit status = 200');
      assertEq(r.json?.run?.status, 'COMPLETED', 'run.status = COMPLETED');
      assertEq(r.json?.nextStep, null, 'no next step');
    }

    // ── Phase 10: 404 on bogus publishable key ────────────────
    console.log('\n10. 404 on bogus publishable key');
    {
      const r = await http(
        'POST',
        '/api/public/widget-flows/by-key/wf_bogus_key/runs',
        {},
      );
      assertEq(r.status, 404, 'bogus key returns 404');
    }

    // ── Phase 11: clean up imported flow ──────────────────────
    console.log('\n11. DELETE imported flow');
    if (importedFlowId) {
      const r = await http('DELETE', `/api/widget-flows/${importedFlowId}`);
      assertEq(r.status, 204, 'delete status = 204');
    }
  } finally {
    await purgeSmokeFlows(organizationId);
    server.close();
    console.log('\nTest server stopped.');
  }

  console.log(`\n${assertionCount} assertions, ${failureCount} failures\n`);
  process.exit(failureCount === 0 ? 0 : 1);
}

main()
  .catch((err) => {
    console.error('\n💥 HTTP smoke test crashed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await enginePrisma.$disconnect();
  });

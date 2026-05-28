/**
 * Engine HTTP smoke test (Phase 3.1 — graph engine v2).
 *
 * Spins up an Express app that mounts the same routes as src/index.ts
 * (minus background jobs), drives admin CRUD + public visitor flows
 * + event triggers via real HTTP fetch calls, and asserts end-to-end
 * behavior on the new graph schema.
 *
 * Covers (each phase = one test scenario):
 *   1. Admin CRUD: create flow + list + get
 *   2. Draft autosave with v2 payload (nodes + edges + entryPoints)
 *   3. Publish blocks on invalid payload (no entry point)
 *   4. Successful publish: publishableKey assigned, snapshot written
 *   5. Export → Import round-trip preserves graph shape
 *   6. Visitor walk-through: 3-node VISITOR flow → COMPLETED
 *   7. Idempotency: replay submit returns cached response
 *   8. Validation errors: invalid email returns errors, run stays put
 *   9. Conditional edge branching
 *  10. EVENT_REACTION via dispatcher → run materializes + completes
 *  11. Activity tab endpoint
 *  12. Usage summary endpoint
 *  13. Trash (DELETE) + archive endpoints work for flows
 *  14. 404 on bogus publishable key
 *  15. WAIT_DURATION + sweeper resumes paused run (Phase 3.2)
 *  16. CREATE_RESUME_LINK + WAIT_TOKEN + GET /resume/:tokenId (Phase 3.2b)
 *  17. ENTITY_REF FORM field: list endpoint + resolve on submit (Phase 3.4)
 *  18. SINGLE_SELECT with optionsSource='entity' resolves entity + projects to vars
 *  19. SINGLE_SELECT with selectionMode='subset' enforces id allow-list + list endpoint filters
 *
 * Uses the existing dev-auth-bypass mechanism in `requireUser`:
 * NODE_ENV != 'production' + DEV_AUTH_BYPASS=true + DEV_DEFAULT_ORG_ID.
 *
 * Usage:
 *   npx ts-node scripts/engineHttpSmokeTest.ts [organizationId]
 *
 * Exit codes:
 *   0  all assertions passed
 *   1  any assertion failed
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

// ─── Assertions ───────────────────────────────────────────────────

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
  app.use('/api/public/widget-flows', publicWidgetFlowRoutes);
  app.use('/api', requireUser);
  app.use('/api/widget-flows', widgetFlowRoutes);
  return app;
}

// ─── Fixture builder ──────────────────────────────────────────────

function buildFlowPayload(name: string) {
  const serviceNode = randomUUID();
  const formNode = randomUUID();
  const recapNode = randomUUID();
  return {
    name,
    description: null,
    kind: 'VISITOR' as const,
    nodes: [
      {
        id: serviceNode,
        kind: 'SINGLE_SELECT',
        label: 'Pick service',
        description: null,
        config: {
          varName: 'service',
          options: [
            { value: 'piano', label: 'Piano' },
            { value: 'guitar', label: 'Guitar' },
          ],
        },
        position: { x: 100, y: 100 },
      },
      {
        id: formNode,
        kind: 'FORM',
        label: 'Your details',
        description: null,
        config: {
          fields: [
            {
              order: 0,
              kind: 'TEXT',
              label: 'First name',
              placeholder: null,
              required: true,
              binding: 'VAR',
              bindingTarget: 'firstname',
              config: {},
            },
            {
              order: 1,
              kind: 'EMAIL',
              label: 'Email',
              placeholder: null,
              required: true,
              binding: 'VAR',
              bindingTarget: 'email',
              config: {},
            },
          ],
        },
        position: { x: 100, y: 300 },
      },
      {
        id: recapNode,
        kind: 'RECAP',
        label: 'Confirm',
        description: null,
        config: {},
        position: { x: 100, y: 500 },
      },
    ],
    edges: [
      { fromNodeId: serviceNode, toNodeId: formNode, order: 0 },
      { fromNodeId: formNode, toNodeId: recapNode, order: 0 },
    ],
    entryPoints: [
      { kind: 'visitor' as const, config: {}, entryNodeId: serviceNode },
    ],
  };
}

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
  console.log(`\nv2 HTTP smoke test — org "${org.name}"\n`);

  process.env.DEV_AUTH_BYPASS = 'true';
  process.env.DEV_DEFAULT_ORG_ID = organizationId;

  await purgeSmokeFlows(organizationId);

  const app = buildApp();
  const server = app.listen(0);
  await new Promise<void>((r) => server.on('listening', () => r()));
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://localhost:${port}`;
  console.log(`Test server listening on ${baseUrl}\n`);

  let createdFlowId: string | null = null;
  let publishableKey: string | null = null;

  try {
    // ── 1. Admin creates a flow ─────────────────────────────
    console.log('1. POST /api/widget-flows — create draft flow');
    {
      const r = await http('POST', '/api/widget-flows', {
        name: '[http-smoke] flow A',
        kind: 'VISITOR',
      });
      assertEq(r.status, 201, 'create status = 201');
      assert(r.json?.flow?.id, 'flow.id returned');
      assertEq(r.json?.flow?.isPublished, false, 'isPublished = false');
      createdFlowId = r.json.flow.id;
    }
    if (!createdFlowId) throw new Error('createdFlowId not set');

    // ── 2. Autosave draft (v2 payload) ──────────────────────
    console.log('\n2. PATCH /api/widget-flows/:id/draft — v2 payload');
    const v2Payload = buildFlowPayload('[http-smoke] flow A');
    {
      const r = await http(
        'PATCH',
        `/api/widget-flows/${createdFlowId}/draft`,
        v2Payload,
      );
      assertEq(r.status, 200, 'PATCH draft status = 200');
      assert(r.json?.draft?.updatedAt, 'draft.updatedAt returned');
    }

    // ── 3. Publish blocked on invalid payload (no entry point) ─
    console.log('\n3. Publish blocked when no entry point');
    {
      const badPayload = { ...v2Payload, entryPoints: [] };
      await http('PATCH', `/api/widget-flows/${createdFlowId}/draft`, badPayload);
      const r = await http('POST', `/api/widget-flows/${createdFlowId}/publish`);
      assertEq(r.status, 422, 'publish blocked status = 422');
      assertEq(r.json?.code, 'PUBLISH_BLOCKED', 'code = PUBLISH_BLOCKED');
      assert(
        Array.isArray(r.json?.issues) && r.json.issues.length > 0,
        'issues array returned',
      );
    }
    // Restore + republish for downstream phases.
    await http('PATCH', `/api/widget-flows/${createdFlowId}/draft`, v2Payload);

    // ── 4. Successful publish ───────────────────────────────
    console.log('\n4. POST /api/widget-flows/:id/publish');
    {
      const r = await http('POST', `/api/widget-flows/${createdFlowId}/publish`);
      assertEq(r.status, 200, 'publish status = 200');
      assertEq(r.json?.flow?.isPublished, true, 'isPublished = true');
      assert(
        typeof r.json?.flow?.publishableKey === 'string' &&
          r.json.flow.publishableKey.startsWith('wf_'),
        'publishableKey assigned (wf_ prefix)',
      );
      assertEq(r.json?.flow?.nodes?.length, 3, '3 nodes persisted');
      assertEq(r.json?.flow?.edges?.length, 2, '2 edges persisted');
      assertEq(r.json?.flow?.entryPoints?.length, 1, '1 entry point persisted');
      publishableKey = r.json.flow.publishableKey;
    }

    // ── 5. Export → import round-trip ───────────────────────
    console.log('\n5. Export + re-import preserves shape');
    let importedFlowId: string | null = null;
    {
      const exportRes = await http(
        'GET',
        `/api/widget-flows/${createdFlowId}/export`,
      );
      assertEq(exportRes.status, 200, 'export status = 200');
      assertEq(exportRes.json?.nodes?.length, 3, 'export has 3 nodes');
      assertEq(exportRes.json?.edges?.length, 2, 'export has 2 edges');

      const importBody = {
        ...exportRes.json,
        name: '[http-smoke] imported flow',
      };
      const importRes = await http('POST', '/api/widget-flows/import', importBody);
      assertEq(importRes.status, 201, 'import status = 201');
      assertEq(importRes.json?.flow?.nodes?.length, 3, 'imported has 3 nodes');
      assertEq(
        importRes.json?.flow?.isPublished,
        false,
        'imported flow is NOT published',
      );
      importedFlowId = importRes.json.flow.id;
    }

    // ── 6. Public visitor walk-through ──────────────────────
    console.log('\n6. Public visitor walks the published flow');
    if (!publishableKey) throw new Error('publishableKey not set');

    let runId: string | null = null;
    let firstNodeId: string | null = null;
    {
      const r = await http(
        'POST',
        `/api/public/widget-flows/by-key/${publishableKey}/runs`,
        {},
      );
      assertEq(r.status, 201, 'createRun status = 201');
      assertEq(r.json?.run?.status, 'WAITING_INPUT', 'status = WAITING_INPUT after walk');
      assertEq(
        r.json?.firstNode?.kind,
        'SINGLE_SELECT',
        'firstNode.kind = SINGLE_SELECT',
      );
      // Public response strips organizationId.
      assertEq(
        (r.json?.run as Record<string, unknown>)?.organizationId,
        undefined,
        'public run does NOT leak organizationId',
      );
      runId = r.json.run.id;
      firstNodeId = r.json.firstNode.id;
    }
    if (!runId || !firstNodeId) throw new Error('runId/firstNodeId not set');

    // Submit SINGLE_SELECT
    const submit1 = randomUUID();
    {
      const r = await http(
        'POST',
        `/api/public/widget-flows/by-key/${publishableKey}/runs/${runId}/nodes/${firstNodeId}/submit`,
        { values: { selected: 'piano' }, clientSubmitId: submit1 },
      );
      assertEq(r.status, 200, 'submit 1 status = 200');
      assertEq(r.json?.errors?.length, 0, 'no errors');
      assertEq(r.json?.replayed, false, 'not replayed');
      assertEq(r.json?.nextNode?.kind, 'FORM', 'nextNode = FORM');
    }

    // ── 7. Idempotent replay ────────────────────────────────
    console.log('\n7. Idempotency: replay same clientSubmitId');
    {
      const r = await http(
        'POST',
        `/api/public/widget-flows/by-key/${publishableKey}/runs/${runId}/nodes/${firstNodeId}/submit`,
        { values: { selected: 'piano' }, clientSubmitId: submit1 },
      );
      assertEq(r.json?.replayed, true, 'replayed = true');
      assertEq(r.json?.errors?.length, 0, 'no errors on replay');
    }

    // ── 8. Validation errors on FORM ────────────────────────
    console.log('\n8. FORM submit with invalid email');
    const formNodeId: string = (
      await http(
        'GET',
        `/api/public/widget-flows/by-key/${publishableKey}/runs/${runId}`,
      )
    ).json?.currentNode?.id;
    {
      const r = await http(
        'POST',
        `/api/public/widget-flows/by-key/${publishableKey}/runs/${runId}/nodes/${formNodeId}/submit`,
        {
          values: { firstname: 'A', email: 'not-an-email' },
          clientSubmitId: randomUUID(),
        },
      );
      assertEq(r.status, 200, 'FORM returns 200 even with errors');
      assert(r.json?.errors?.length > 0, 'errors returned');
      assert(
        r.json.errors.some((e: any) => e.field === 'email'),
        'error on email field',
      );
    }

    // FORM submit valid → RECAP
    {
      const r = await http(
        'POST',
        `/api/public/widget-flows/by-key/${publishableKey}/runs/${runId}/nodes/${formNodeId}/submit`,
        {
          values: { firstname: 'Alice', email: 'alice@example.com' },
          clientSubmitId: randomUUID(),
        },
      );
      assertEq(r.json?.nextNode?.kind, 'RECAP', 'nextNode = RECAP');
    }

    // RECAP → COMPLETED
    const recapNodeId: string = (
      await http(
        'GET',
        `/api/public/widget-flows/by-key/${publishableKey}/runs/${runId}`,
      )
    ).json?.currentNode?.id;
    {
      const r = await http(
        'POST',
        `/api/public/widget-flows/by-key/${publishableKey}/runs/${runId}/nodes/${recapNodeId}/submit`,
        { values: {}, clientSubmitId: randomUUID() },
      );
      assertEq(r.json?.run?.status, 'COMPLETED', 'run.status = COMPLETED');
      assertEq(r.json?.nextNode, null, 'no next node');
    }

    // ── 9. Conditional edge branching ───────────────────────
    console.log('\n9. Conditional edge branching');
    {
      // Build a 4-node flow with two outgoing edges from the first
      // SINGLE_SELECT, gated by JSONLogic. selected=skip → bypass
      // node B; selected=keep → through node B.
      const a = randomUUID();
      const b = randomUUID();
      const c = randomUUID();
      const branchFlow = await http('POST', '/api/widget-flows', {
        name: '[http-smoke] branch flow',
        kind: 'VISITOR',
      });
      const branchFlowId = branchFlow.json.flow.id;

      const branchPayload = {
        name: '[http-smoke] branch flow',
        description: null,
        kind: 'VISITOR' as const,
        nodes: [
          {
            id: a,
            kind: 'SINGLE_SELECT',
            label: 'Skip step?',
            description: null,
            config: {
              varName: 'skip',
              options: [
                { value: 'skip', label: 'Skip' },
                { value: 'keep', label: 'Keep' },
              ],
            },
            position: { x: 0, y: 0 },
          },
          {
            id: b,
            kind: 'SINGLE_SELECT',
            label: 'Optional',
            description: null,
            config: {
              varName: 'optional',
              options: [{ value: 'x', label: 'X' }],
            },
            position: { x: 0, y: 200 },
          },
          {
            id: c,
            kind: 'RECAP',
            label: 'Done',
            description: null,
            config: {},
            position: { x: 0, y: 400 },
          },
        ],
        edges: [
          // From A: if skip → C (bypass B); else → B.
          {
            fromNodeId: a,
            toNodeId: c,
            order: 0,
            condition: { '==': [{ var: 'vars.skip' }, 'skip'] },
          },
          { fromNodeId: a, toNodeId: b, order: 1 },
          // B → C
          { fromNodeId: b, toNodeId: c, order: 0 },
        ],
        entryPoints: [
          { kind: 'visitor' as const, config: {}, entryNodeId: a },
        ],
      };

      await http('PATCH', `/api/widget-flows/${branchFlowId}/draft`, branchPayload);
      const pubB = await http(
        'POST',
        `/api/widget-flows/${branchFlowId}/publish`,
      );
      assertEq(pubB.status, 200, 'branch flow published');
      const branchKey = pubB.json.flow.publishableKey;

      // Path A: skip → bypass B
      const runA = await http(
        'POST',
        `/api/public/widget-flows/by-key/${branchKey}/runs`,
        {},
      );
      const runAId = runA.json.run.id;
      const submitA = await http(
        'POST',
        `/api/public/widget-flows/by-key/${branchKey}/runs/${runAId}/nodes/${a}/submit`,
        { values: { selected: 'skip' }, clientSubmitId: randomUUID() },
      );
      assertEq(
        submitA.json?.nextNode?.label,
        'Done',
        'skip path bypasses B → lands on Done',
      );

      // Path B: keep → through B
      const runB = await http(
        'POST',
        `/api/public/widget-flows/by-key/${branchKey}/runs`,
        {},
      );
      const runBId = runB.json.run.id;
      const submitB = await http(
        'POST',
        `/api/public/widget-flows/by-key/${branchKey}/runs/${runBId}/nodes/${a}/submit`,
        { values: { selected: 'keep' }, clientSubmitId: randomUUID() },
      );
      assertEq(
        submitB.json?.nextNode?.label,
        'Optional',
        'keep path lands on B',
      );

      await http('DELETE', `/api/widget-flows/${branchFlowId}`);
    }

    // ── 10. EVENT_REACTION via dispatcher ───────────────────
    console.log('\n10. EVENT_REACTION via dispatcher');
    {
      const reaction = randomUUID();
      const reactionFlow = await http('POST', '/api/widget-flows', {
        name: '[http-smoke] reaction flow',
        kind: 'EVENT_REACTION',
      });
      const reactionFlowId = reactionFlow.json.flow.id;

      const reactionPayload = {
        name: '[http-smoke] reaction flow',
        description: null,
        kind: 'EVENT_REACTION' as const,
        nodes: [
          {
            id: reaction,
            kind: 'SEND_EMAIL',
            label: 'Send confirmation',
            description: null,
            config: {
              to: 'admin@example.com',
              subject: 'Payment {vars.paymentId}',
              bodyHtml: '<p>{vars.amount}</p>',
            },
            position: { x: 0, y: 0 },
          },
        ],
        edges: [],
        entryPoints: [
          {
            kind: 'event' as const,
            config: { eventName: 'payment.succeeded' },
            entryNodeId: reaction,
          },
        ],
      };

      await http(
        'PATCH',
        `/api/widget-flows/${reactionFlowId}/draft`,
        reactionPayload,
      );
      const pubR = await http(
        'POST',
        `/api/widget-flows/${reactionFlowId}/publish`,
      );
      assertEq(pubR.status, 200, 'reaction flow published');
      assertEq(
        pubR.json?.flow?.publishableKey,
        null,
        'EVENT_REACTION has NO publishableKey',
      );

      // Drive the dispatcher synchronously.
      const { _dispatchForTests } = await import(
        '../src/services/engine/triggerDispatcher'
      );
      await _dispatchForTests('payment.succeeded', {
        organizationId,
        payload: {
          paymentId: 'pi_test_v2',
          scheduledEventId: null,
          submissionId: null,
          enrollmentInviteId: null,
          purpose: null,
          amount: 1500,
        },
      });
      await new Promise((r) => setTimeout(r, 100));

      const runs = await prisma.widgetRun.findMany({
        where: { flowId: reactionFlowId },
        orderBy: { startedAt: 'desc' },
      });
      assertEq(runs.length, 1, 'one EVENT_REACTION run materialized');
      assertEq(runs[0].status, 'COMPLETED', 'run reached COMPLETED');
      assertEq(
        (runs[0].vars as any)?.paymentId,
        'pi_test_v2',
        'vars seeded from payload',
      );

      await http('DELETE', `/api/widget-flows/${reactionFlowId}`);
    }

    // ── 11. Activity tab endpoint ───────────────────────────
    console.log('\n11. GET /api/widget-flows/:id/runs (Activity tab)');
    {
      const r = await http('GET', `/api/widget-flows/${createdFlowId}/runs`);
      assertEq(r.status, 200, 'runs status = 200');
      assert(Array.isArray(r.json?.runs), 'runs array returned');
      assert(
        r.json.runs.some((run: any) => run.status === 'COMPLETED'),
        'at least one COMPLETED run',
      );
    }

    // ── 12. Usage summary endpoint ──────────────────────────
    console.log('\n12. GET /api/widget-flows/usage/summary');
    {
      const r = await http('GET', '/api/widget-flows/usage/summary');
      assertEq(r.status, 200, 'usage status = 200');
      assert(r.json?.thisMonth > 0, 'thisMonth > 0');
      assert(
        typeof r.json?.byKind?.RUN_START === 'number' &&
          r.json.byKind.RUN_START > 0,
        'RUN_START kind tracked',
      );
    }

    // ── 13. Trash / DELETE = soft-delete ────────────────────
    console.log('\n13. Trash + delete behavior');
    if (importedFlowId) {
      const r = await http('DELETE', `/api/widget-flows/${importedFlowId}`);
      assertEq(r.status, 204, 'delete status = 204 (soft-delete)');
      // Verify it's actually soft-deleted: list endpoint no longer
      // returns it.
      const list = await http('GET', '/api/widget-flows');
      const stillThere = list.json?.flows?.some(
        (f: any) => f.id === importedFlowId,
      );
      assertEq(stillThere, false, 'soft-deleted flow not in list');
    }

    // ── 14. 404 on bogus key ────────────────────────────────
    console.log('\n14. 404 on bogus publishable key');
    {
      const r = await http(
        'POST',
        '/api/public/widget-flows/by-key/wf_bogus_xxxxx/runs',
        {},
      );
      assertEq(r.status, 404, 'bogus key returns 404');
    }

    // ── 15. WAIT_DURATION + sweeper (Phase 3.2) ─────────────
    // Build a 3-node flow: SINGLE_SELECT → WAIT_DURATION(100ms) → RECAP.
    // Walk to the WAIT, verify status WAITING_TIME + scheduled-resume
    // row written, drive the sweeper, verify run reaches COMPLETED.
    console.log('\n15. WAIT_DURATION + sweeper (Phase 3.2)');
    {
      const select = randomUUID();
      const wait = randomUUID();
      const recap = randomUUID();
      const create = await http('POST', '/api/widget-flows', {
        name: '[http-smoke] wait flow',
        kind: 'VISITOR',
      });
      const waitFlowId = create.json.flow.id;

      const waitPayload = {
        name: '[http-smoke] wait flow',
        description: null,
        kind: 'VISITOR' as const,
        nodes: [
          {
            id: select,
            kind: 'SINGLE_SELECT',
            label: 'Pick',
            description: null,
            config: {
              varName: 'pick',
              options: [{ value: 'go', label: 'Go' }],
            },
            position: { x: 0, y: 0 },
          },
          {
            id: wait,
            kind: 'WAIT_DURATION',
            label: 'Wait briefly',
            description: null,
            // 100ms — long enough that the run pauses, short enough
            // that the smoke can wait it out without burning time.
            config: { durationMs: 100 },
            position: { x: 0, y: 200 },
          },
          {
            id: recap,
            kind: 'RECAP',
            label: 'Done',
            description: null,
            config: {},
            position: { x: 0, y: 400 },
          },
        ],
        edges: [
          { fromNodeId: select, toNodeId: wait, order: 0 },
          { fromNodeId: wait, toNodeId: recap, order: 0 },
        ],
        entryPoints: [
          { kind: 'visitor' as const, config: {}, entryNodeId: select },
        ],
      };

      await http('PATCH', `/api/widget-flows/${waitFlowId}/draft`, waitPayload);
      const pubW = await http('POST', `/api/widget-flows/${waitFlowId}/publish`);
      assertEq(pubW.status, 200, 'wait flow published');
      const waitKey = pubW.json.flow.publishableKey;

      const runStart = await http(
        'POST',
        `/api/public/widget-flows/by-key/${waitKey}/runs`,
        {},
      );
      const waitRunId = runStart.json.run.id;
      // Submit the SELECT — run should advance to WAIT_DURATION + pause.
      await http(
        'POST',
        `/api/public/widget-flows/by-key/${waitKey}/runs/${waitRunId}/nodes/${select}/submit`,
        { values: { selected: 'go' }, clientSubmitId: randomUUID() },
      );

      // Inspect the run + the scheduled-resume row.
      const pausedRun = await prisma.widgetRun.findUniqueOrThrow({
        where: { id: waitRunId },
      });
      assertEq(pausedRun.status, 'WAITING_TIME', 'run is WAITING_TIME');
      assertEq(pausedRun.currentNodeId, wait, 'currentNodeId points at WAIT node');
      assert(pausedRun.nextResumeAt != null, 'nextResumeAt set');

      const scheduled = await prisma.widgetScheduledResume.findMany({
        where: { runId: waitRunId, consumed: false },
      });
      assertEq(scheduled.length, 1, 'one scheduled-resume row written');

      // Wait out the 100ms + drive the sweeper synchronously.
      await new Promise((r) => setTimeout(r, 150));
      const { _tickOnceForTests } = await import('../src/jobs/engineResume');
      const resumedCount = await _tickOnceForTests();
      assert(resumedCount >= 1, 'sweeper resumed at least one run');

      // After the sweep, the run walked from WAIT → RECAP. RECAP is
      // a UI node — it pauses for visitor input. So status is now
      // WAITING_INPUT + currentNodeId = recap. This is correct
      // behavior; the visitor finishes by submitting RECAP.
      const afterSweep = await prisma.widgetRun.findUniqueOrThrow({
        where: { id: waitRunId },
      });
      assertEq(afterSweep.status, 'WAITING_INPUT', 'run on RECAP after sweep');
      assertEq(afterSweep.currentNodeId, recap, 'cursor advanced to RECAP');

      // Scheduled row marked consumed by the sweeper.
      const consumedRows = await prisma.widgetScheduledResume.findMany({
        where: { runId: waitRunId, consumed: true },
      });
      assertEq(consumedRows.length, 1, 'scheduled row marked consumed');

      // Visitor submits RECAP → COMPLETED.
      await http(
        'POST',
        `/api/public/widget-flows/by-key/${waitKey}/runs/${waitRunId}/nodes/${recap}/submit`,
        { values: {}, clientSubmitId: randomUUID() },
      );
      const final = await prisma.widgetRun.findUniqueOrThrow({
        where: { id: waitRunId },
      });
      assertEq(final.status, 'COMPLETED', 'run COMPLETED after RECAP submit');

      await http('DELETE', `/api/widget-flows/${waitFlowId}`);
    }

    // ── 16. CREATE_RESUME_LINK + WAIT_TOKEN + resume URL (3.2b) ─
    // Build a 4-node flow:
    //   SINGLE_SELECT → CREATE_RESUME_LINK → WAIT_TOKEN → RECAP
    // Walk to WAIT_TOKEN, verify the run pauses + a resume token
    // was generated + vars.resumeUrl was populated. Then hit
    // GET /api/public/widget-flows/resume/:tokenId to consume the
    // token, verify the run resumes onto RECAP. Submitting RECAP
    // completes the run.
    console.log('\n16. CREATE_RESUME_LINK + WAIT_TOKEN + resume URL (Phase 3.2b)');
    {
      const select = randomUUID();
      const linkAction = randomUUID();
      const waitToken = randomUUID();
      const recap = randomUUID();
      const create = await http('POST', '/api/widget-flows', {
        name: '[http-smoke] token flow',
        kind: 'VISITOR',
      });
      const tokenFlowId = create.json.flow.id;

      const tokenPayload = {
        name: '[http-smoke] token flow',
        description: null,
        kind: 'VISITOR' as const,
        nodes: [
          {
            id: select,
            kind: 'SINGLE_SELECT',
            label: 'Start',
            description: null,
            config: {
              varName: 'start',
              options: [{ value: 'go', label: 'Go' }],
            },
            position: { x: 0, y: 0 },
          },
          {
            id: linkAction,
            kind: 'CREATE_RESUME_LINK',
            label: 'Generate resume link',
            description: null,
            config: {
              urlVar: 'resumeUrl',
              tokenVar: 'resumeToken',
              expirationDays: 7,
              publicBaseUrl: 'https://smoke.example.com',
            },
            position: { x: 0, y: 200 },
          },
          {
            id: waitToken,
            kind: 'WAIT_TOKEN',
            label: 'Wait for click',
            description: null,
            config: { expirationDays: 7 },
            position: { x: 0, y: 400 },
          },
          {
            id: recap,
            kind: 'RECAP',
            label: 'Thanks',
            description: null,
            config: {},
            position: { x: 0, y: 600 },
          },
        ],
        edges: [
          { fromNodeId: select, toNodeId: linkAction, order: 0 },
          { fromNodeId: linkAction, toNodeId: waitToken, order: 0 },
          { fromNodeId: waitToken, toNodeId: recap, order: 0 },
        ],
        entryPoints: [
          { kind: 'visitor' as const, config: {}, entryNodeId: select },
        ],
      };

      await http('PATCH', `/api/widget-flows/${tokenFlowId}/draft`, tokenPayload);
      const pubT = await http('POST', `/api/widget-flows/${tokenFlowId}/publish`);
      assertEq(pubT.status, 200, 'token flow published');
      const tokenKey = pubT.json.flow.publishableKey;

      // Visitor starts a run + submits the SINGLE_SELECT.
      const runStart = await http(
        'POST',
        `/api/public/widget-flows/by-key/${tokenKey}/runs`,
        {},
      );
      const tokenRunId = runStart.json.run.id;
      await http(
        'POST',
        `/api/public/widget-flows/by-key/${tokenKey}/runs/${tokenRunId}/nodes/${select}/submit`,
        { values: { selected: 'go' }, clientSubmitId: randomUUID() },
      );

      // After submitting: CREATE_RESUME_LINK runs, then WAIT_TOKEN
      // pauses. Verify the run + vars + token row.
      const pausedRun = await prisma.widgetRun.findUniqueOrThrow({
        where: { id: tokenRunId },
      });
      assertEq(pausedRun.status, 'WAITING_TOKEN', 'run is WAITING_TOKEN');
      assertEq(
        pausedRun.currentNodeId,
        waitToken,
        'currentNodeId points at WAIT_TOKEN',
      );
      const pausedVars = pausedRun.vars as Record<string, unknown>;
      assert(
        typeof pausedVars.resumeUrl === 'string' &&
          (pausedVars.resumeUrl as string).startsWith(
            'https://smoke.example.com/widget-flow/resume/',
          ),
        'vars.resumeUrl interpolated with publicBaseUrl',
      );
      assert(
        typeof pausedVars.resumeToken === 'string',
        'vars.resumeToken populated',
      );

      const tokens = await prisma.widgetResumeToken.findMany({
        where: { runId: tokenRunId, consumed: false },
      });
      assertEq(tokens.length, 1, 'one unconsumed resume token written');
      const resumeTokenId = tokens[0].id;
      assertEq(
        pausedVars.resumeToken,
        resumeTokenId,
        'vars.resumeToken matches DB row id',
      );

      // Click the URL — calls the public resume endpoint.
      const resume = await http(
        'GET',
        `/api/public/widget-flows/resume/${resumeTokenId}`,
      );
      assertEq(resume.status, 200, 'resume status = 200');
      assertEq(resume.json?.runId, tokenRunId, 'resume returns same runId');
      assertEq(
        resume.json?.publishableKey,
        tokenKey,
        'resume returns the flow publishableKey',
      );
      assertEq(
        resume.json?.run?.status,
        'WAITING_INPUT',
        'run advanced to WAITING_INPUT after token consumed',
      );
      assertEq(
        resume.json?.currentNode?.kind,
        'RECAP',
        'currentNode is RECAP after resume',
      );

      // Token row is now consumed.
      const consumedToken = await prisma.widgetResumeToken.findUniqueOrThrow({
        where: { id: resumeTokenId },
      });
      assertEq(consumedToken.consumed, true, 'token marked consumed');
      assert(consumedToken.consumedAt != null, 'consumedAt timestamp set');

      // Second click of the same URL fails — single-use enforcement.
      const replay = await http(
        'GET',
        `/api/public/widget-flows/resume/${resumeTokenId}`,
      );
      assertEq(replay.status, 409, 'replay of consumed token returns 409');

      // Bogus token id returns 404.
      const bogus = await http(
        'GET',
        `/api/public/widget-flows/resume/${randomUUID()}`,
      );
      assertEq(bogus.status, 404, 'bogus token id returns 404');

      // Visitor finishes by submitting RECAP → COMPLETED.
      await http(
        'POST',
        `/api/public/widget-flows/by-key/${tokenKey}/runs/${tokenRunId}/nodes/${recap}/submit`,
        { values: {}, clientSubmitId: randomUUID() },
      );
      const finalRun = await prisma.widgetRun.findUniqueOrThrow({
        where: { id: tokenRunId },
      });
      assertEq(finalRun.status, 'COMPLETED', 'run COMPLETED after RECAP submit');

      await http('DELETE', `/api/widget-flows/${tokenFlowId}`);
    }

    // ── 17. ENTITY_REF list endpoint + resolve on submit (3.4) ──
    // Build a 2-node flow: FORM with ENTITY_REF(facilitator) → RECAP.
    // Seed a Facilitator row scoped to this org, walk a visitor
    // through, verify:
    //   - GET /entities/facilitator returns the seeded row
    //   - submit with the facilitator id resolves + writes
    //     vars.facilitator = { id, label, email, ... }
    //   - submit with a bogus id produces a validation error
    //   - GET /entities/<unknown-type> returns empty (entityType
    //     never reaches the registry, doesn't throw)
    //   - cross-org id (different org's facilitator) is rejected
    //     as "not found" — proves org scoping
    console.log('\n17. ENTITY_REF FORM field (Phase 3.4)');
    {
      // Seed two facilitators so we can test the multi-row list.
      const seeded = await Promise.all([
        prisma.facilitator.create({
          data: {
            organizationId,
            firstname: 'SmokeAlpha',
            lastname: 'Tester',
            email: 'alpha@smoke.test',
            phone: '5555550100',
            color: '#ff0000',
            availability: {},
            isBookable: true,
            isBioDisplayed: false,
          },
        }),
        prisma.facilitator.create({
          data: {
            organizationId,
            firstname: 'SmokeBeta',
            lastname: 'Tester',
            email: 'beta@smoke.test',
            phone: '5555550200',
            color: '#00ff00',
            availability: {},
            isBookable: true,
            isBioDisplayed: false,
          },
        }),
      ]);

      // Find another org's facilitator (if any exist) to test cross-
      // org rejection. Skip the cross-org assertion if there are no
      // other orgs (e.g. fresh dev DB).
      const otherOrgFac = await prisma.facilitator.findFirst({
        where: {
          organizationId: { not: organizationId },
          isBookable: true,
        },
      });

      const form = randomUUID();
      const recap = randomUUID();
      const entityFlow = await http('POST', '/api/widget-flows', {
        name: '[http-smoke] entity-ref flow',
        kind: 'VISITOR',
      });
      const entityFlowId = entityFlow.json.flow.id;

      const entityPayload = {
        name: '[http-smoke] entity-ref flow',
        description: null,
        kind: 'VISITOR' as const,
        nodes: [
          {
            id: form,
            kind: 'FORM',
            label: 'Choisir un intervenant',
            description: null,
            config: {
              fields: [
                {
                  order: 0,
                  kind: 'ENTITY_REF',
                  label: 'Intervenant',
                  required: true,
                  binding: 'VAR',
                  bindingTarget: 'facilitator',
                  config: {
                    entityType: 'facilitator',
                    extractFields: ['email', 'firstname'],
                  },
                },
              ],
            },
            position: { x: 0, y: 0 },
          },
          {
            id: recap,
            kind: 'RECAP',
            label: 'Confirmer',
            description: null,
            config: {},
            position: { x: 0, y: 200 },
          },
        ],
        edges: [{ fromNodeId: form, toNodeId: recap, order: 0 }],
        entryPoints: [
          { kind: 'visitor' as const, config: {}, entryNodeId: form },
        ],
      };

      try {
        await http(
          'PATCH',
          `/api/widget-flows/${entityFlowId}/draft`,
          entityPayload,
        );
        const pubE = await http(
          'POST',
          `/api/widget-flows/${entityFlowId}/publish`,
        );
        assertEq(pubE.status, 200, 'entity-ref flow published');
        const entityKey = pubE.json.flow.publishableKey;

        // 17a. List endpoint returns the seeded facilitators.
        const listRes = await http(
          'GET',
          `/api/public/widget-flows/by-key/${entityKey}/entities/facilitator`,
        );
        assertEq(listRes.status, 200, 'entity list status = 200');
        assert(
          Array.isArray(listRes.json?.entities),
          'list returns entities array',
        );
        const listedIds = new Set(
          (listRes.json.entities as { id: string }[]).map((e) => e.id),
        );
        assert(
          listedIds.has(seeded[0].id) && listedIds.has(seeded[1].id),
          'both seeded facilitators in the list',
        );
        // Cross-org leak check: another org's facilitator must NOT
        // appear in the list.
        if (otherOrgFac) {
          assert(
            !listedIds.has(otherOrgFac.id),
            'cross-org facilitator NOT leaked in list',
          );
        }
        // Safe-fields projection: list rows expose `fields` with
        // only the registry's whitelist (no raw Prisma columns).
        const firstEntity = (listRes.json.entities as Array<{
          id: string;
          label: string;
          fields: Record<string, unknown>;
        }>).find((e) => e.id === seeded[0].id);
        assert(firstEntity != null, 'seeded facilitator returned');
        assertEq(
          firstEntity?.label,
          'SmokeAlpha Tester',
          'label = firstname + lastname',
        );
        assertEq(
          firstEntity?.fields?.email,
          'alpha@smoke.test',
          'fields.email present',
        );

        // 17b. Unknown entity type → empty array, no 500.
        const unknownRes = await http(
          'GET',
          `/api/public/widget-flows/by-key/${entityKey}/entities/spaceship`,
        );
        assertEq(unknownRes.status, 200, 'unknown type returns 200');
        assertEq(
          (unknownRes.json?.entities ?? []).length,
          0,
          'unknown type returns empty list',
        );

        // 17c. Submit with the picked facilitator id.
        const runStart = await http(
          'POST',
          `/api/public/widget-flows/by-key/${entityKey}/runs`,
          {},
        );
        const entityRunId = runStart.json.run.id;
        const okSubmit = await http(
          'POST',
          `/api/public/widget-flows/by-key/${entityKey}/runs/${entityRunId}/nodes/${form}/submit`,
          {
            values: { facilitator: seeded[0].id },
            clientSubmitId: randomUUID(),
          },
        );
        assertEq(okSubmit.status, 200, 'valid submit status = 200');
        assertEq(
          okSubmit.json?.errors?.length,
          0,
          'no errors on valid entity pick',
        );
        assertEq(
          okSubmit.json?.nextNode?.kind,
          'RECAP',
          'advanced to RECAP after resolve',
        );

        // Verify vars projection: vars.facilitator = { id, label, email }
        const resolvedRun = await prisma.widgetRun.findUniqueOrThrow({
          where: { id: entityRunId },
        });
        const vars = resolvedRun.vars as Record<string, unknown>;
        const fac = vars.facilitator as
          | { id?: string; label?: string; email?: string; firstname?: string }
          | undefined;
        assertEq(fac?.id, seeded[0].id, 'vars.facilitator.id matches pick');
        assertEq(
          fac?.email,
          'alpha@smoke.test',
          'vars.facilitator.email extracted',
        );
        assertEq(
          fac?.firstname,
          'SmokeAlpha',
          'vars.facilitator.firstname extracted',
        );
        assertEq(
          fac?.label,
          'SmokeAlpha Tester',
          'vars.facilitator.label populated',
        );

        // 17d. Bogus id → validation error, run stays put.
        const bogusRun = await http(
          'POST',
          `/api/public/widget-flows/by-key/${entityKey}/runs`,
          {},
        );
        const bogusRunId = bogusRun.json.run.id;
        const badSubmit = await http(
          'POST',
          `/api/public/widget-flows/by-key/${entityKey}/runs/${bogusRunId}/nodes/${form}/submit`,
          {
            values: { facilitator: 'not-a-real-id' },
            clientSubmitId: randomUUID(),
          },
        );
        assertEq(badSubmit.status, 200, 'bogus id status = 200 (validation)');
        assert(
          (badSubmit.json?.errors ?? []).some(
            (e: { field?: string }) => e.field === 'facilitator',
          ),
          'validation error on facilitator field for bogus id',
        );
        assertEq(
          badSubmit.json?.nextNode?.kind,
          'FORM',
          'run did NOT advance past FORM',
        );

        // 17e. Cross-org id → validation error (org scoping).
        if (otherOrgFac) {
          const crossRun = await http(
            'POST',
            `/api/public/widget-flows/by-key/${entityKey}/runs`,
            {},
          );
          const crossRunId = crossRun.json.run.id;
          const crossSubmit = await http(
            'POST',
            `/api/public/widget-flows/by-key/${entityKey}/runs/${crossRunId}/nodes/${form}/submit`,
            {
              values: { facilitator: otherOrgFac.id },
              clientSubmitId: randomUUID(),
            },
          );
          assert(
            (crossSubmit.json?.errors ?? []).some(
              (e: { field?: string }) => e.field === 'facilitator',
            ),
            'cross-org facilitator id rejected as "not found"',
          );
        }

        await http('DELETE', `/api/widget-flows/${entityFlowId}`);
      } finally {
        // Clean up seeded fixture rows regardless of test outcome.
        await prisma.facilitator.deleteMany({
          where: { id: { in: seeded.map((f) => f.id) } },
        });
      }
    }

    // ── 18. SINGLE_SELECT with entity source ──────────────────
    // Build a 2-node flow: SINGLE_SELECT(entity=facilitator) → RECAP.
    // Seed a facilitator, walk a visitor through, verify:
    //   - the picked id is validated against the entity registry
    //   - vars.facilitator lands as a resolved object with extracted
    //     fields (id, label, email, …), same shape ENTITY_REF uses
    //   - bogus id produces a validation error, run stays put
    console.log('\n18. SINGLE_SELECT with optionsSource=entity (May 2026)');
    {
      const seeded = await prisma.facilitator.create({
        data: {
          organizationId,
          firstname: 'SmokeGamma',
          lastname: 'Tester',
          email: 'gamma@smoke.test',
          phone: '5555550300',
          color: '#0000ff',
          availability: {},
          isBookable: true,
          isBioDisplayed: false,
        },
      });

      const select = randomUUID();
      const recap = randomUUID();
      const entityFlow = await http('POST', '/api/widget-flows', {
        name: '[http-smoke] SS-entity flow',
        kind: 'VISITOR',
      });
      const entityFlowId = entityFlow.json.flow.id;

      const payload = {
        name: '[http-smoke] SS-entity flow',
        description: null,
        kind: 'VISITOR' as const,
        nodes: [
          {
            id: select,
            kind: 'SINGLE_SELECT',
            label: 'Choisir un intervenant',
            description: null,
            config: {
              varName: 'facilitator',
              optionsSource: 'entity',
              entityType: 'facilitator',
              extractFields: ['email', 'firstname'],
            },
            position: { x: 0, y: 0 },
          },
          {
            id: recap,
            kind: 'RECAP',
            label: 'Confirmer',
            description: null,
            config: {},
            position: { x: 0, y: 200 },
          },
        ],
        edges: [{ fromNodeId: select, toNodeId: recap, order: 0 }],
        entryPoints: [
          { kind: 'visitor' as const, config: {}, entryNodeId: select },
        ],
      };

      try {
        await http('PATCH', `/api/widget-flows/${entityFlowId}/draft`, payload);
        const pub = await http('POST', `/api/widget-flows/${entityFlowId}/publish`);
        assertEq(pub.status, 200, 'SS-entity flow published');
        const key = pub.json.flow.publishableKey;

        // Visitor picks the seeded facilitator by id.
        const runStart = await http(
          'POST',
          `/api/public/widget-flows/by-key/${key}/runs`,
          {},
        );
        const runId = runStart.json.run.id;
        const okSubmit = await http(
          'POST',
          `/api/public/widget-flows/by-key/${key}/runs/${runId}/nodes/${select}/submit`,
          { values: { selected: seeded.id }, clientSubmitId: randomUUID() },
        );
        assertEq(okSubmit.status, 200, 'entity pick status = 200');
        assertEq(
          okSubmit.json?.errors?.length,
          0,
          'no errors on entity-source SINGLE_SELECT',
        );
        assertEq(
          okSubmit.json?.nextNode?.kind,
          'RECAP',
          'advanced to RECAP',
        );

        const run = await prisma.widgetRun.findUniqueOrThrow({
          where: { id: runId },
        });
        const vars = run.vars as Record<string, unknown>;
        const fac = vars.facilitator as
          | { id?: string; label?: string; email?: string; firstname?: string }
          | undefined;
        assertEq(
          fac?.id,
          seeded.id,
          'vars.facilitator.id matches the entity picked',
        );
        assertEq(
          fac?.email,
          'gamma@smoke.test',
          'vars.facilitator.email extracted from entity',
        );
        assertEq(
          fac?.firstname,
          'SmokeGamma',
          'vars.facilitator.firstname extracted',
        );

        // Bogus id → validation error, run stays put.
        const bogusRun = await http(
          'POST',
          `/api/public/widget-flows/by-key/${key}/runs`,
          {},
        );
        const bogusRunId = bogusRun.json.run.id;
        const badSubmit = await http(
          'POST',
          `/api/public/widget-flows/by-key/${key}/runs/${bogusRunId}/nodes/${select}/submit`,
          {
            values: { selected: 'not-a-real-id' },
            clientSubmitId: randomUUID(),
          },
        );
        assertEq(
          badSubmit.status,
          200,
          'bogus id status = 200 (validation)',
        );
        assert(
          (badSubmit.json?.errors ?? []).some(
            (e: { field?: string }) => e.field === 'selected',
          ),
          'bogus entity id produces "selected" validation error',
        );
        assertEq(
          badSubmit.json?.nextNode?.kind,
          'SINGLE_SELECT',
          'run did NOT advance past SINGLE_SELECT on bogus id',
        );

        await http('DELETE', `/api/widget-flows/${entityFlowId}`);
      } finally {
        await prisma.facilitator.delete({ where: { id: seeded.id } });
      }
    }

    // ── 19. SINGLE_SELECT subset filter enforcement ─────────────
    // Seed THREE facilitators. Configure SINGLE_SELECT with
    // selectionMode='subset' allowing only the first two. Verify:
    //   - GET /entities?ids=A,B returns only A + B (not C)
    //   - submit with A is accepted, vars projected
    //   - submit with C (the excluded one) is rejected even though
    //     the entity exists + belongs to the same org
    console.log('\n19. SINGLE_SELECT subset filter enforcement');
    {
      const seeded = await Promise.all(
        ['Delta', 'Epsilon', 'Zeta'].map((name, i) =>
          prisma.facilitator.create({
            data: {
              organizationId,
              firstname: `Smoke${name}`,
              lastname: 'Tester',
              email: `${name.toLowerCase()}@smoke.test`,
              phone: `555555040${i}`,
              color: '#abcdef',
              availability: {},
              isBookable: true,
              isBioDisplayed: false,
            },
          }),
        ),
      );
      const [a, b, c] = seeded;

      const select = randomUUID();
      const recap = randomUUID();
      const subsetFlow = await http('POST', '/api/widget-flows', {
        name: '[http-smoke] SS-subset flow',
        kind: 'VISITOR',
      });
      const subsetFlowId = subsetFlow.json.flow.id;

      const payload = {
        name: '[http-smoke] SS-subset flow',
        description: null,
        kind: 'VISITOR' as const,
        nodes: [
          {
            id: select,
            kind: 'SINGLE_SELECT',
            label: 'Choisir parmi A ou B (pas C)',
            description: null,
            config: {
              varName: 'facilitator',
              optionsSource: 'entity',
              entityType: 'facilitator',
              extractFields: ['email'],
              selectionMode: 'subset',
              entityIds: [a.id, b.id],
            },
            position: { x: 0, y: 0 },
          },
          {
            id: recap,
            kind: 'RECAP',
            label: 'Confirmer',
            description: null,
            config: {},
            position: { x: 0, y: 200 },
          },
        ],
        edges: [{ fromNodeId: select, toNodeId: recap, order: 0 }],
        entryPoints: [
          { kind: 'visitor' as const, config: {}, entryNodeId: select },
        ],
      };

      try {
        await http('PATCH', `/api/widget-flows/${subsetFlowId}/draft`, payload);
        const pub = await http('POST', `/api/widget-flows/${subsetFlowId}/publish`);
        assertEq(pub.status, 200, 'SS-subset flow published');
        const key = pub.json.flow.publishableKey;

        // Endpoint with ?ids=a,b returns ONLY a + b.
        const filteredList = await http(
          'GET',
          `/api/public/widget-flows/by-key/${key}/entities/facilitator?ids=${a.id},${b.id}`,
        );
        assertEq(filteredList.status, 200, 'filtered list status = 200');
        const filteredIds = new Set(
          (filteredList.json.entities as { id: string }[]).map((e) => e.id),
        );
        assertEq(filteredIds.size, 2, 'filtered list returns exactly 2 entities');
        assert(
          filteredIds.has(a.id) && filteredIds.has(b.id),
          'filtered list contains A + B',
        );
        assert(!filteredIds.has(c.id), 'filtered list does NOT contain C');

        // Submit A → accepted.
        const runStart = await http(
          'POST',
          `/api/public/widget-flows/by-key/${key}/runs`,
          {},
        );
        const runId = runStart.json.run.id;
        const okSubmit = await http(
          'POST',
          `/api/public/widget-flows/by-key/${key}/runs/${runId}/nodes/${select}/submit`,
          { values: { selected: a.id }, clientSubmitId: randomUUID() },
        );
        assertEq(okSubmit.status, 200, 'in-subset pick status = 200');
        assertEq(
          okSubmit.json?.errors?.length,
          0,
          'no errors on in-subset pick',
        );
        assertEq(
          okSubmit.json?.nextNode?.kind,
          'RECAP',
          'advanced to RECAP on in-subset pick',
        );

        // Submit C (excluded but real + same org) → rejected.
        const blockedRun = await http(
          'POST',
          `/api/public/widget-flows/by-key/${key}/runs`,
          {},
        );
        const blockedRunId = blockedRun.json.run.id;
        const blockedSubmit = await http(
          'POST',
          `/api/public/widget-flows/by-key/${key}/runs/${blockedRunId}/nodes/${select}/submit`,
          { values: { selected: c.id }, clientSubmitId: randomUUID() },
        );
        assertEq(
          blockedSubmit.status,
          200,
          'out-of-subset pick status = 200 (validation)',
        );
        assert(
          (blockedSubmit.json?.errors ?? []).some(
            (e: { field?: string }) => e.field === 'selected',
          ),
          'out-of-subset pick produces validation error',
        );
        assertEq(
          blockedSubmit.json?.nextNode?.kind,
          'SINGLE_SELECT',
          'run did NOT advance past SINGLE_SELECT on out-of-subset pick',
        );

        await http('DELETE', `/api/widget-flows/${subsetFlowId}`);
      } finally {
        await prisma.facilitator.deleteMany({
          where: { id: { in: seeded.map((f) => f.id) } },
        });
      }
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
    console.error('\n💥 v2 HTTP smoke test crashed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await enginePrisma.$disconnect();
  });

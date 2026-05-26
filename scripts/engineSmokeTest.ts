/**
 * Engine smoke test — Phase 2.0 Commit 2.
 *
 * Builds an in-memory flow (SINGLE_SELECT → FORM → RECAP), drives it
 * end-to-end through the engine, then tears the test data back down.
 * Verifies:
 *   - happy path: 3 submits advance the run to COMPLETED
 *   - validation: invalid email is reported and does NOT advance
 *   - idempotency: replaying a submit with the same clientSubmitId
 *     returns the cached result on both validation-fail and success
 *   - metering: one EngineActionEvent per RUN_START / STEP_SUBMIT /
 *     STEP_VALIDATION_FAILED / RUN_COMPLETE
 *
 * Usage:
 *   npx ts-node scripts/engineSmokeTest.ts [organizationId]
 *
 * organizationId defaults to DEV_DEFAULT_ORG_ID env or the dev seed
 * org's known cuid. The script is non-destructive — only the flow it
 * creates (and the run/submits cascading from it) gets deleted at end.
 *
 * Exit codes:
 *   0  all assertions passed
 *   1  any assertion failed or unexpected error
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';

// Inline-imported engine API. The smoke test runs against the SAME
// prisma client the engine uses (singleton in src/prisma.ts), not a
// fresh PrismaClient here — that's important because the engine
// expects writes from this script to be visible inside its queries.
import {
  startRun,
  submitStep,
  advanceStep,
  completeRun,
  EngineError,
} from '../src/services/engine/flowEngine';
import enginePrisma from '../src/prisma';

const prisma = new PrismaClient();

// ─── Assertion helpers ────────────────────────────────────────────

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

// ─── Fixture builders ─────────────────────────────────────────────

async function buildTestFlow(organizationId: string) {
  const flow = await prisma.widgetFlow.create({
    data: {
      organizationId,
      name: '[smoke-test] engine commit 2',
      description: 'Created + deleted by scripts/engineSmokeTest.ts',
      kind: 'BOOKING',
      isPublished: true,
      publishableKey: `smoke_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      version: 1,
      steps: {
        create: [
          {
            order: 0,
            kind: 'SINGLE_SELECT',
            label: "Choisissez l'instrument",
            config: {
              varName: 'instrument',
              options: [
                { value: 'piano', label: 'Piano' },
                { value: 'guitar', label: 'Guitare' },
                { value: 'violin', label: 'Violon' },
              ],
            },
          },
          {
            order: 1,
            kind: 'FORM',
            label: 'Vos coordonnées',
            fields: {
              create: [
                {
                  order: 0,
                  kind: 'TEXT',
                  label: 'Prénom',
                  required: true,
                  binding: 'VAR',
                  bindingTarget: 'firstname',
                  config: {},
                },
                {
                  order: 1,
                  kind: 'EMAIL',
                  label: 'Email',
                  required: true,
                  binding: 'VAR',
                  bindingTarget: 'email',
                  config: {},
                },
              ],
            },
          },
          {
            order: 2,
            kind: 'RECAP',
            label: 'Confirmation',
            config: {},
          },
        ],
      },
    },
    include: { steps: { include: { fields: true }, orderBy: { order: 'asc' } } },
  });
  return flow;
}

async function teardown(flowId: string) {
  // WidgetRun.flow defaults to onDelete: RESTRICT (intentional —
  // deleting a flow shouldn't wipe its run history for analytics /
  // audit). For the smoke test we DO want a clean teardown, so we
  // delete in dependency order:
  //   1. EngineActionEvent (no FK; indirect via flowId)
  //   2. WidgetRun         (cascades into WidgetRunSubmit)
  //   3. WidgetFlow        (cascades into Step / Field / Draft / Snapshot)
  await prisma.engineActionEvent.deleteMany({ where: { flowId } });
  await prisma.widgetRun.deleteMany({ where: { flowId } });
  await prisma.widgetFlow.delete({ where: { id: flowId } });
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
  console.log(`\nRunning engine smoke test against org "${org.name}" (${org.id})\n`);

  const flow = await buildTestFlow(organizationId);
  console.log(`Built flow ${flow.id} with ${flow.steps.length} steps\n`);

  try {
    // ── Phase 1: startRun ─────────────────────────────────────
    console.log('1. startRun()');
    const { run, firstStep } = await startRun({
      flowId: flow.id,
      organizationId,
    });
    assert(run, 'run created');
    assertEq(run.status, 'IN_PROGRESS', 'run.status = IN_PROGRESS');
    assertEq(run.currentStepId, flow.steps[0].id, 'currentStepId = step[0].id');
    assert(firstStep, 'firstStep returned');
    assertEq(firstStep?.kind, 'SINGLE_SELECT', 'firstStep.kind = SINGLE_SELECT');

    // ── Phase 2: submit SINGLE_SELECT ─────────────────────────
    console.log('\n2. submitStep() on SINGLE_SELECT');
    const submit1Id = randomUUID();
    const result1 = await submitStep({
      runId: run.id,
      stepId: flow.steps[0].id,
      submission: {
        values: { selected: 'piano' },
        clientSubmitId: submit1Id,
      },
    });
    assertEq(result1.errors.length, 0, 'no errors');
    assertEq(result1.replayed, false, 'not replayed');
    assertEq(result1.nextStep?.id, flow.steps[1].id, 'nextStep = FORM');
    assertEq(result1.run.status, 'IN_PROGRESS', 'still IN_PROGRESS');
    assertEq(
      (result1.run.vars as Record<string, unknown>).instrument,
      'piano',
      'vars.instrument = piano',
    );

    // ── Phase 3: idempotent replay of step 1 ──────────────────
    console.log('\n3. submitStep() replay with same clientSubmitId');
    const result1Replay = await submitStep({
      runId: run.id,
      stepId: flow.steps[0].id,
      submission: {
        values: { selected: 'piano' },
        clientSubmitId: submit1Id,
      },
    });
    assertEq(result1Replay.replayed, true, 'replayed = true');
    assertEq(result1Replay.errors.length, 0, 'no errors on replay');
    assertEq(
      result1Replay.run.currentStepId,
      flow.steps[1].id,
      'run still on step[1] after replay',
    );

    // ── Phase 4: FORM with invalid email ──────────────────────
    console.log('\n4. submitStep() FORM with invalid email');
    const submitInvalidId = randomUUID();
    const resultInvalid = await submitStep({
      runId: run.id,
      stepId: flow.steps[1].id,
      submission: {
        values: { firstname: 'Alice', email: 'not-an-email' },
        clientSubmitId: submitInvalidId,
      },
    });
    assert(resultInvalid.errors.length > 0, 'returns validation errors');
    assertEq(resultInvalid.replayed, false, 'not replayed');
    assert(
      resultInvalid.errors.some((e) => e.field === 'email'),
      'has error on `email` field',
    );
    assertEq(
      resultInvalid.run.currentStepId,
      flow.steps[1].id,
      'run still on FORM step (no advance)',
    );

    // ── Phase 5: idempotent replay of the FAILED submit ───────
    console.log('\n5. submitStep() replay of the failed submit');
    const resultInvalidReplay = await submitStep({
      runId: run.id,
      stepId: flow.steps[1].id,
      submission: {
        // Note: different values — replay should ignore them because
        // the clientSubmitId already exists.
        values: { firstname: 'Bob', email: 'bob@example.com' },
        clientSubmitId: submitInvalidId,
      },
    });
    assertEq(resultInvalidReplay.replayed, true, 'replayed = true');
    assert(
      resultInvalidReplay.errors.length > 0,
      'errors preserved on replay (not silently succeeded)',
    );

    // ── Phase 6: FORM with valid data ─────────────────────────
    console.log('\n6. submitStep() FORM with valid data');
    const submit2Id = randomUUID();
    const result2 = await submitStep({
      runId: run.id,
      stepId: flow.steps[1].id,
      submission: {
        values: { firstname: 'Alice', email: 'alice@example.com' },
        clientSubmitId: submit2Id,
      },
    });
    assertEq(result2.errors.length, 0, 'no errors');
    assertEq(result2.nextStep?.kind, 'RECAP', 'nextStep = RECAP');
    assertEq(
      (result2.run.vars as Record<string, unknown>).firstname,
      'Alice',
      'vars.firstname = Alice',
    );
    assertEq(
      (result2.run.vars as Record<string, unknown>).email,
      'alice@example.com',
      'vars.email = alice@…',
    );

    // ── Phase 7: RECAP confirms → COMPLETED ───────────────────
    console.log('\n7. submitStep() RECAP confirm → COMPLETED');
    const submit3Id = randomUUID();
    const result3 = await submitStep({
      runId: run.id,
      stepId: flow.steps[2].id,
      submission: {
        values: {},
        clientSubmitId: submit3Id,
      },
    });
    assertEq(result3.errors.length, 0, 'no errors');
    assertEq(result3.nextStep, null, 'no next step');
    assertEq(result3.run.status, 'COMPLETED', 'run.status = COMPLETED');
    assert(result3.run.completedAt != null, 'completedAt set');

    // ── Phase 8: advanceStep on completed run ─────────────────
    console.log('\n8. advanceStep() on completed run');
    const advance = await advanceStep({ runId: run.id });
    assertEq(advance.run.status, 'COMPLETED', 'advance.run.status = COMPLETED');
    assertEq(advance.currentStep, null, 'no current step');

    // ── Phase 9: metering rows ────────────────────────────────
    console.log('\n9. EngineActionEvent rows');
    const events = await prisma.engineActionEvent.findMany({
      where: { runId: run.id },
      orderBy: { executedAt: 'asc' },
    });
    const kinds = events.map((e) => e.actionKind);
    assert(kinds.includes('RUN_START'), 'has RUN_START');
    assert(kinds.includes('STEP_SUBMIT'), 'has STEP_SUBMIT');
    assert(kinds.includes('STEP_VALIDATION_FAILED'), 'has STEP_VALIDATION_FAILED');
    assert(kinds.includes('RUN_COMPLETE'), 'has RUN_COMPLETE');
    // Replays should NOT log metering — keep the count exact:
    //   1× RUN_START + 2× STEP_SUBMIT (steps 0 + 1) + 1× STEP_VALIDATION_FAILED
    //   + 1× RUN_COMPLETE = 5 events.
    assertEq(events.length, 5, 'exactly 5 metering rows (no replays counted)');

    // ── Phase 10: completeRun is idempotent ───────────────────
    console.log('\n10. completeRun() on already-COMPLETED run');
    const completed = await completeRun({ runId: run.id });
    assertEq(completed.status, 'COMPLETED', 'still COMPLETED');

    // ── Phase 11: EngineError shape ───────────────────────────
    console.log('\n11. EngineError on unknown run');
    let threw = false;
    try {
      await submitStep({
        runId: 'does-not-exist',
        stepId: flow.steps[0].id,
        submission: { values: { selected: 'piano' }, clientSubmitId: randomUUID() },
      });
    } catch (err) {
      threw = true;
      assert(err instanceof EngineError, 'threw EngineError');
      assertEq(
        (err as EngineError).code,
        'RUN_NOT_FOUND',
        'code = RUN_NOT_FOUND',
      );
    }
    assert(threw, 'submitStep threw for unknown runId');
  } finally {
    await teardown(flow.id);
    console.log(`\nTorn down flow ${flow.id}`);
  }

  console.log(`\n${assertionCount} assertions, ${failureCount} failures\n`);
  process.exit(failureCount === 0 ? 0 : 1);
}

main()
  .catch(async (err) => {
    console.error('\n💥 Smoke test crashed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await enginePrisma.$disconnect();
  });

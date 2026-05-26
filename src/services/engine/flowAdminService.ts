// Admin-side workflow engine service (Phase 2.0 Commit 3).
//
// Owns the CRUD + draft-publish lifecycle:
//   list / get / create / delete  — basic CRUD
//   getDraft / patchDraft         — autosave-to-draft loop
//   publish                       — draft → normalized + snapshot + bump
//   exportFlow / importFlow       — JSON round-trip
//
// All methods take `organizationId` explicitly and scope every query
// to it (defense-in-depth — even if the prisma extension didn't auto-
// scope WidgetFlow, these methods would still be safe).
//
// Publish strategy:
//   1. Load draft. If none, error.
//   2. Validate via validatePublishable(). If issues, return them
//      without writing.
//   3. Inside one transaction:
//      a. Compute next version (current + 1, or 1 on first publish)
//      b. writePayloadToFlow() — replace steps/fields with the draft
//      c. Update flow: version++, isPublished=true,
//         publishableKey if missing
//      d. Create a WidgetFlowSnapshot keyed (flowId, version)
//   4. Return the published flow.
//
// Snapshots only happen on Publish — autosave is draft-only. That
// keeps the snapshot table small + every entry semantically meaningful.

import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';

import prisma from '../../prisma';
import {
  flowToPayload,
  validatePublishable,
  writePayloadToFlow,
  type PublishIssue,
} from './flowSerialization';
import type { FlowPayload } from '../../validations/widgetFlow.validation';

// ─── Errors ───────────────────────────────────────────────────────

export class FlowAdminError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'NOT_FOUND'
      | 'NO_DRAFT'
      | 'PUBLISH_BLOCKED',
    public readonly issues?: PublishIssue[],
  ) {
    super(message);
    this.name = 'FlowAdminError';
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * URL-safe random key for the publishable URL slug. 24 bytes of entropy
 * (192 bits) — far beyond what's needed to prevent guessing, leaves
 * plenty of room for a `wf_` prefix without bloating the URL.
 *
 * Format: `wf_<48 hex chars>`. The prefix makes keys easy to spot in
 * logs and clearly distinguishes them from BookingWidget cuids.
 */
function generatePublishableKey(): string {
  return `wf_${randomBytes(24).toString('hex')}`;
}

const FLOW_LIST_SELECT = {
  id: true,
  name: true,
  description: true,
  kind: true,
  isPublished: true,
  isTemplate: true,
  publishableKey: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const;

const FLOW_DETAIL_INCLUDE = {
  steps: {
    orderBy: { order: 'asc' as const },
    include: { fields: { orderBy: { order: 'asc' as const } } },
  },
  // Phase 2.2 — actions ship with the flow detail so the editor can
  // round-trip them through draft/publish/export without a separate
  // fetch. Returned as a flat list; flowToPayload() reshapes into the
  // nested tree the admin UI consumes.
  actions: {
    orderBy: { order: 'asc' as const },
  },
};

// ─── Service methods ──────────────────────────────────────────────

export async function listFlows(organizationId: string) {
  return prisma.widgetFlow.findMany({
    where: { organizationId },
    select: FLOW_LIST_SELECT,
    orderBy: { updatedAt: 'desc' },
  });
}

export async function getFlow(organizationId: string, flowId: string) {
  const flow = await prisma.widgetFlow.findFirst({
    where: { id: flowId, organizationId },
    include: FLOW_DETAIL_INCLUDE,
  });
  if (!flow) throw new FlowAdminError(`Flow ${flowId} not found`, 'NOT_FOUND');
  return flow;
}

export async function createFlow(params: {
  organizationId: string;
  name: string;
  description?: string;
  kind: 'BOOKING' | 'EVENT_REACTION';
}) {
  return prisma.widgetFlow.create({
    data: {
      organizationId: params.organizationId,
      name: params.name,
      description: params.description ?? null,
      kind: params.kind,
      isPublished: false,
      version: 1,
      // publishableKey is null until first Publish — public URLs aren't
      // valid yet for a flow that has never been validated.
    },
    select: FLOW_LIST_SELECT,
  });
}

export async function deleteFlow(organizationId: string, flowId: string) {
  // Verify ownership first to avoid leaking cross-tenant existence
  // via timing on the .delete() error.
  const existing = await prisma.widgetFlow.findFirst({
    where: { id: flowId, organizationId },
    select: { id: true },
  });
  if (!existing) throw new FlowAdminError(`Flow ${flowId} not found`, 'NOT_FOUND');

  // WidgetRun has onDelete: Restrict for analytics retention. We
  // explicitly wipe runs first when the admin asks to delete — the
  // intent is "remove this flow entirely". A future commit may add
  // a "deactivate but keep runs" flag.
  await prisma.engineActionEvent.deleteMany({ where: { flowId } });
  await prisma.widgetRun.deleteMany({ where: { flowId } });
  await prisma.widgetFlow.delete({ where: { id: flowId } });
}

// ─── Draft ────────────────────────────────────────────────────────

export async function getDraft(organizationId: string, flowId: string) {
  const flow = await prisma.widgetFlow.findFirst({
    where: { id: flowId, organizationId },
    select: { id: true, draft: true },
  });
  if (!flow) throw new FlowAdminError(`Flow ${flowId} not found`, 'NOT_FOUND');
  return flow.draft?.payload ?? null;
}

/**
 * Autosave target. Upserts the WidgetFlowDraft row keyed on flowId.
 * Idempotent on the same payload — same data in, same row out.
 *
 * Does NOT touch the normalized flow rows. The point of draft is to
 * persist mid-edit state safely; only Publish reaches into the live
 * tables.
 */
export async function patchDraft(
  organizationId: string,
  flowId: string,
  payload: FlowPayload,
) {
  const flow = await prisma.widgetFlow.findFirst({
    where: { id: flowId, organizationId },
    select: { id: true },
  });
  if (!flow) throw new FlowAdminError(`Flow ${flowId} not found`, 'NOT_FOUND');

  return prisma.widgetFlowDraft.upsert({
    where: { flowId },
    update: { payload: payload as unknown as Prisma.InputJsonValue },
    create: {
      flowId,
      payload: payload as unknown as Prisma.InputJsonValue,
    },
  });
}

// ─── Publish ──────────────────────────────────────────────────────

export async function publishFlow(organizationId: string, flowId: string) {
  // 1. Load the flow + its draft. Bail if no draft (admin needs to
  // save changes before publishing).
  const flow = await prisma.widgetFlow.findFirst({
    where: { id: flowId, organizationId },
    select: {
      id: true,
      version: true,
      publishableKey: true,
      draft: { select: { payload: true } },
    },
  });
  if (!flow) throw new FlowAdminError(`Flow ${flowId} not found`, 'NOT_FOUND');
  if (!flow.draft) {
    throw new FlowAdminError(
      'Aucun brouillon à publier. Effectuez d\'abord une modification.',
      'NO_DRAFT',
    );
  }

  // 2. Validate. Bail with structured issues if any.
  const payload = flow.draft.payload as unknown as FlowPayload;
  const issues = validatePublishable(payload);
  if (issues.length > 0) {
    throw new FlowAdminError(
      'Le brouillon contient des erreurs qui empêchent la publication.',
      'PUBLISH_BLOCKED',
      issues,
    );
  }

  // 3. Apply atomically: normalized writes + flow update + snapshot.
  const nextVersion = flow.version + 1;
  const publishableKey = flow.publishableKey ?? generatePublishableKey();

  return prisma.$transaction(async (tx) => {
    await writePayloadToFlow(tx, flowId, payload);

    const updated = await tx.widgetFlow.update({
      where: { id: flowId },
      data: {
        version: nextVersion,
        isPublished: true,
        publishableKey,
      },
      include: FLOW_DETAIL_INCLUDE,
    });

    await tx.widgetFlowSnapshot.create({
      data: {
        flowId,
        version: nextVersion,
        payload: payload as unknown as Prisma.InputJsonValue,
      },
    });

    // The draft has been consumed by this publish — delete it so the
    // editor's "has unpublished changes" comparison can never go stale
    // against a leftover draft that's actually identical to the live
    // state. Next edit creates a fresh draft via the autosave PATCH.
    await tx.widgetFlowDraft.delete({ where: { flowId } });

    return updated;
  });
}

// ─── Export / Import ──────────────────────────────────────────────

/**
 * Build the export JSON for a flow. Pulls the LIVE published state
 * (not the draft) so the export reflects exactly what visitors see.
 * Admins who want to share a work-in-progress should Publish first or
 * export the draft separately (future).
 */
export async function exportFlow(organizationId: string, flowId: string) {
  const flow = await getFlow(organizationId, flowId);
  return flowToPayload(flow);
}

/**
 * Import creates a NEW flow with a fresh id + cleared publishableKey
 * (NOT published yet — admin must explicitly Publish after import).
 * The imported payload is written to BOTH the normalized rows AND the
 * draft so the admin can edit straight away.
 */
export async function importFlow(
  organizationId: string,
  payload: FlowPayload,
) {
  return prisma.$transaction(async (tx) => {
    // Create the flow shell first so we have an id for normalized
    // child rows + the draft.
    const flow = await tx.widgetFlow.create({
      data: {
        organizationId,
        name: payload.name,
        description: payload.description ?? null,
        kind: payload.kind,
        isPublished: false,
        version: 1,
      },
      select: { id: true },
    });

    await writePayloadToFlow(tx, flow.id, payload);

    await tx.widgetFlowDraft.create({
      data: {
        flowId: flow.id,
        payload: payload as unknown as Prisma.InputJsonValue,
      },
    });

    return tx.widgetFlow.findUniqueOrThrow({
      where: { id: flow.id },
      include: FLOW_DETAIL_INCLUDE,
    });
  });
}

// ─── Activity / runs feed ─────────────────────────────────────────

const RUNS_PAGE_DEFAULT = 20;
const RUNS_PAGE_MAX = 100;

/**
 * List runs for a flow, newest first. Pagination via offset/limit.
 *
 * Public-safe shape: deliberately OMITS `vars` (visitor PII — emails,
 * names, free-form input) and `stepHistory` (heavy + only useful for
 * drop-off analytics). The admin Activity tab only needs status +
 * timing for v1; a future "run detail" endpoint can return the full
 * vars + history when the admin clicks into a specific run.
 */
export async function listFlowRuns(
  organizationId: string,
  flowId: string,
  opts: { limit?: number; offset?: number } = {},
) {
  // Ownership check first so cross-tenant probes can't enumerate
  // runs via a known flow id from another org.
  const flow = await prisma.widgetFlow.findFirst({
    where: { id: flowId, organizationId },
    select: { id: true },
  });
  if (!flow) throw new FlowAdminError(`Flow ${flowId} not found`, 'NOT_FOUND');

  const limit = Math.min(opts.limit ?? RUNS_PAGE_DEFAULT, RUNS_PAGE_MAX);
  const offset = Math.max(opts.offset ?? 0, 0);

  const [runs, total] = await Promise.all([
    prisma.widgetRun.findMany({
      where: { flowId },
      select: {
        id: true,
        status: true,
        startedAt: true,
        completedAt: true,
        currentStepId: true,
        // stepHistory is JSON — pulling .length out of it requires the
        // app layer. Returning the raw stepHistory would balloon
        // the payload + leak more than the admin needs.
        // For now, surface a derived "stepsSubmitted" count.
        stepHistory: true,
      },
      orderBy: { startedAt: 'desc' },
      skip: offset,
      take: limit,
    }),
    prisma.widgetRun.count({ where: { flowId } }),
  ]);

  return {
    runs: runs.map((r) => ({
      id: r.id,
      status: r.status,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      currentStepId: r.currentStepId,
      stepsSubmitted: Array.isArray(r.stepHistory)
        ? r.stepHistory.length
        : 0,
    })),
    total,
    limit,
    offset,
  };
}

// ─── Usage summary (engine action metering) ───────────────────────

/**
 * Build the per-org engine usage summary surfaced in /admin/parametres
 * (and eventually the per-org billing dashboard).
 *
 * Two windows for the headline numbers:
 *   - thisMonth: counts since the 1st of the current month
 *   - last30Days: trailing 30-day rolling window
 *
 * Plus a per-kind breakdown for the current month so the admin can
 * see what's driving the count (mostly RUN_START + STEP_SUBMIT today;
 * SEND_EMAIL / ISSUE_REFUND etc. land in Phase 2.2+).
 *
 * No quota / budget enforcement in v1 — purely measurement. The UI
 * uses a soft visual threshold to indicate scale, but every action
 * still fires.
 */
export async function getUsageSummary(organizationId: string) {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOf30DayWindow = new Date(now);
  startOf30DayWindow.setDate(startOf30DayWindow.getDate() - 30);

  const [thisMonthRows, last30Rows, byKindRows] = await Promise.all([
    prisma.engineActionEvent.count({
      where: { organizationId, executedAt: { gte: startOfMonth } },
    }),
    prisma.engineActionEvent.count({
      where: { organizationId, executedAt: { gte: startOf30DayWindow } },
    }),
    prisma.engineActionEvent.groupBy({
      by: ['actionKind'],
      where: { organizationId, executedAt: { gte: startOfMonth } },
      _count: { _all: true },
    }),
  ]);

  const byKind: Record<string, number> = {};
  for (const row of byKindRows) {
    byKind[row.actionKind] = row._count._all;
  }

  return {
    thisMonth: thisMonthRows,
    last30Days: last30Rows,
    byKind,
    windowStart: startOfMonth.toISOString(),
    last30WindowStart: startOf30DayWindow.toISOString(),
  };
}

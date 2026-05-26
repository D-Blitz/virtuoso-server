// Flow draft / publish serialization (Phase 2.0 Commit 3).
//
// One source of truth for the FlowPayload shape — the JSON blob used
// by WidgetFlowDraft.payload, WidgetFlowSnapshot.payload, and the
// export/import endpoints.
//
// Two transforms live here:
//   1. normalize → payload  (read normalized rows + return FlowPayload)
//   2. payload → normalized writes  (used by publish() to apply a
//      draft into the live flow's WidgetStep / WidgetField rows)
//
// Plus a pure-data validatePublishable() that enforces the minimum
// invariants we want every PUBLISHED flow to hold:
//   - at least one step
//   - all step.order values unique
//   - all field.order values unique within each step
//   - every step kind has a wired handler (Commit 2 only ships three)
//   - every field references a known kind / binding

import { Prisma } from '@prisma/client';
import type {
  PrismaClient,
  WidgetAction,
  WidgetStepKind,
  WidgetTrigger,
} from '@prisma/client';

import prisma from '../../prisma';
import { getActionHandler } from './actionHandlers';
import { stepHandlers } from './stepHandlers';
import type { FlowPayload } from '../../validations/widgetFlow.validation';

/**
 * The transaction client type as exposed by our extended Prisma client.
 *
 * `Prisma.TransactionClient` is the UNEXTENDED type — passing the
 * extended `tx` argument into a function typed against it triggers
 * structural-incompatibility errors (the extension widens the client
 * surface). Deriving the type from `prisma.$transaction` keeps the
 * extension layer in lockstep.
 */
type ExtendedTransactionClient = Parameters<
  Parameters<typeof prisma.$transaction>[0]
>[0];

// ─── Validation ───────────────────────────────────────────────────

export type PublishIssue = {
  /** Path to the offending element, e.g. "steps[2].fields[1].label". */
  path: string;
  message: string;
};

/**
 * Returns the list of publish-blocking issues. Empty array = OK to
 * publish. Surfaces every issue in one pass so the admin sees the
 * full picture rather than fixing one and discovering another.
 */
export function validatePublishable(payload: FlowPayload): PublishIssue[] {
  const issues: PublishIssue[] = [];

  // Validate the action tree (Phase 2.2). Done first so action issues
  // surface even for flows with zero steps. Walks the tree depth-first
  // so paths render with full nesting context: actions[0].children[2].kind
  function walkActions(
    actions: Array<{ kind: string; config: unknown; children?: unknown[] }>,
    pathPrefix: string,
  ): void {
    for (const [i, action] of actions.entries()) {
      const path = `${pathPrefix}[${i}]`;
      const handler = getActionHandler(action.kind);
      if (!handler) {
        issues.push({
          path: `${path}.kind`,
          message:
            `Le type d'action "${action.kind}" n'est pas pris en charge. ` +
            `Types supportés : SEND_EMAIL, CONDITIONAL, WAIT.`,
        });
        continue; // can't validate config without a handler
      }
      const configError = handler.validateConfig(action.config as Prisma.JsonValue);
      if (configError) {
        issues.push({
          path: `${path}.config`,
          message: configError,
        });
      }
      const children = action.children as
        | Array<{ kind: string; config: unknown; children?: unknown[] }>
        | undefined;
      if (children && children.length > 0) {
        walkActions(children, `${path}.children`);
      }
    }
  }
  walkActions(
    (payload.actions ?? []) as Array<{
      kind: string;
      config: unknown;
      children?: unknown[];
    }>,
    'actions',
  );

  // Phase 2.3 — trigger validation. Each trigger MUST reference an
  // event name the dispatcher knows about. Filter syntax isn't deeply
  // checked here — the expression evaluator's size/depth limits fire
  // at trigger time and the dispatcher logs failures separately.
  const knownEventNames = new Set([
    'payment.succeeded',
    'payment.failed',
    'payment.refunded',
    'event.cancelled',
  ]);
  for (const [i, trigger] of (payload.triggers ?? []).entries()) {
    if (!knownEventNames.has(trigger.eventName)) {
      issues.push({
        path: `triggers[${i}].eventName`,
        message:
          `Événement "${trigger.eventName}" inconnu du dispatcher. ` +
          `Valeurs supportées : ${Array.from(knownEventNames).join(', ')}.`,
      });
    }
  }

  // EVENT_REACTION flows must have at least one trigger to be useful
  // (otherwise they never fire). BOOKING flows can have zero — they're
  // driven by visitor submits.
  if (
    payload.kind === 'EVENT_REACTION' &&
    (payload.triggers ?? []).length === 0
  ) {
    issues.push({
      path: 'triggers',
      message:
        'Un flow de type EVENT_REACTION doit avoir au moins un déclencheur, ' +
        'sinon il ne s’exécutera jamais.',
    });
  }

  // EVENT_REACTION flows DON'T need steps (their action tree is the
  // whole behavior). BOOKING flows still need at least one step.
  if (payload.kind === 'BOOKING' && payload.steps.length === 0) {
    issues.push({
      path: 'steps',
      message: 'Le flow BOOKING doit contenir au moins une étape.',
    });
    return issues;
  }

  // EVENT_REACTION with no steps is fine — skip per-step validation.
  if (payload.steps.length === 0) {
    return issues;
  }

  // step.order uniqueness
  const stepOrders = new Set<number>();
  for (const [i, step] of payload.steps.entries()) {
    if (stepOrders.has(step.order)) {
      issues.push({
        path: `steps[${i}].order`,
        message: `Ordre dupliqué (${step.order}) — chaque étape doit avoir un ordre unique.`,
      });
    }
    stepOrders.add(step.order);

    // Step kind must have a handler (Commit 2 only wires three; the
    // schema's enum lists more for future use). Publish blocks rather
    // than letting a flow ship with steps that would 500 at runtime.
    if (!stepHandlers[step.kind as WidgetStepKind]) {
      issues.push({
        path: `steps[${i}].kind`,
        message:
          `Le type d'étape "${step.kind}" n'est pas encore pris en charge ` +
          `par le moteur. Types supportés : SINGLE_SELECT, FORM, RECAP.`,
      });
    }

    // field.order uniqueness within step + binding sanity
    const fieldOrders = new Set<number>();
    for (const [j, field] of step.fields.entries()) {
      if (fieldOrders.has(field.order)) {
        issues.push({
          path: `steps[${i}].fields[${j}].order`,
          message: `Ordre dupliqué (${field.order}) dans cette étape.`,
        });
      }
      fieldOrders.add(field.order);

      // Empty bindingTarget would silently no-op in apply(). Catch
      // it at publish time instead.
      if (!field.bindingTarget || field.bindingTarget.length === 0) {
        issues.push({
          path: `steps[${i}].fields[${j}].bindingTarget`,
          message: 'Le champ doit avoir une cible de binding non vide.',
        });
      }
    }
  }

  return issues;
}

// ─── Normalize → Payload ──────────────────────────────────────────

type NormalizedFlow = Prisma.WidgetFlowGetPayload<{
  include: {
    steps: { include: { fields: true } };
    actions: true;
    triggers: true;
  };
}>;

type ActionPayloadNode = {
  order: number;
  kind: string;
  config: Record<string, unknown>;
  children: ActionPayloadNode[];
};

/**
 * Build the nested actions tree from the flat WidgetAction rows.
 * Two-pass O(n) build keyed by id. Children are sorted by order.
 */
function actionsToPayload(actions: WidgetAction[]): ActionPayloadNode[] {
  const nodes = new Map<string, ActionPayloadNode & { _id: string }>();
  for (const a of actions) {
    nodes.set(a.id, {
      _id: a.id,
      order: a.order,
      kind: a.kind,
      config: (a.config ?? {}) as Record<string, unknown>,
      children: [],
    });
  }
  const roots: ActionPayloadNode[] = [];
  for (const a of actions) {
    const node = nodes.get(a.id)!;
    if (a.parentId == null) {
      roots.push(node);
    } else {
      const parent = nodes.get(a.parentId);
      if (parent) parent.children.push(node);
      else roots.push(node); // orphan promoted
    }
  }
  // Sort children per-parent.
  for (const node of nodes.values()) {
    node.children.sort((a, b) => a.order - b.order);
  }
  // Strip the internal _id helper before returning.
  const strip = (n: ActionPayloadNode & { _id?: string }): ActionPayloadNode => {
    delete n._id;
    n.children.forEach(strip);
    return n;
  };
  return roots.sort((a, b) => a.order - b.order).map(strip);
}

/**
 * Read the normalized WidgetFlow + WidgetStep + WidgetField +
 * WidgetAction rows back into a FlowPayload. Used to seed the draft
 * on first edit and to build export JSON.
 *
 * Strips all system-managed fields (ids, timestamps, publishableKey,
 * version, isPublished) so the output round-trips cleanly through the
 * payload schema.
 */
export function flowToPayload(flow: NormalizedFlow): FlowPayload {
  return {
    name: flow.name,
    description: flow.description,
    kind: flow.kind,
    steps: [...flow.steps]
      .sort((a, b) => a.order - b.order)
      .map((step) => ({
        order: step.order,
        kind: step.kind,
        label: step.label,
        description: step.description,
        config: (step.config ?? {}) as Record<string, unknown>,
        visibleWhen: step.visibleWhen as unknown,
        fields: [...step.fields]
          .sort((a, b) => a.order - b.order)
          .map((field) => ({
            order: field.order,
            kind: field.kind,
            label: field.label,
            placeholder: field.placeholder,
            required: field.required,
            binding: field.binding,
            bindingTarget: field.bindingTarget,
            config: (field.config ?? {}) as Record<string, unknown>,
          })),
      })),
    actions: actionsToPayload(flow.actions ?? []),
    triggers: (flow.triggers ?? []).map((t: WidgetTrigger) => ({
      eventName: t.eventName,
      filter: t.filter as unknown,
    })),
  };
}

// ─── Payload → Normalized writes ──────────────────────────────────

/**
 * Apply a FlowPayload to the live normalized tables.
 *
 * Strategy: delete-and-recreate the step + field rows under the flow.
 * Cheaper than a row-by-row diff and avoids partial-update hazards
 * (orphaned fields when a step is removed, etc.). The flow row itself
 * is updated in place to preserve its id + publishableKey for the
 * public URL.
 *
 * MUST be called inside a transaction — the caller is responsible.
 * Returns the updated flow id (the same id passed in; convenience).
 */
export async function writePayloadToFlow(
  tx: ExtendedTransactionClient,
  flowId: string,
  payload: FlowPayload,
): Promise<void> {
  // Cascade: deleting a WidgetStep deletes its WidgetField children.
  await tx.widgetStep.deleteMany({ where: { flowId } });

  // Update flow scalars
  await tx.widgetFlow.update({
    where: { id: flowId },
    data: {
      name: payload.name,
      description: payload.description ?? null,
      kind: payload.kind,
    },
  });

  // Recreate steps + fields
  for (const step of payload.steps) {
    await tx.widgetStep.create({
      data: {
        flowId,
        order: step.order,
        kind: step.kind,
        label: step.label,
        description: step.description ?? null,
        config: (step.config ?? {}) as Prisma.InputJsonValue,
        visibleWhen:
          step.visibleWhen == null
            ? Prisma.JsonNull
            : (step.visibleWhen as Prisma.InputJsonValue),
        fields: {
          create: step.fields.map((field) => ({
            order: field.order,
            kind: field.kind,
            label: field.label,
            placeholder: field.placeholder ?? null,
            required: field.required,
            binding: field.binding,
            bindingTarget: field.bindingTarget,
            config: (field.config ?? {}) as Prisma.InputJsonValue,
          })),
        },
      },
    });
  }

  // Phase 2.2 — actions. Delete + recreate (same strategy as steps)
  // so removing an action via the editor doesn't leave an orphan row.
  // Cascade-delete on WidgetAction.parentId handles the tree wipe.
  await tx.widgetAction.deleteMany({ where: { flowId } });
  await writeActionTree(tx, flowId, null, payload.actions ?? []);

  // Phase 2.3 — triggers. Flat list, no tree. Same delete + recreate
  // strategy so removing a trigger via the editor drops it cleanly.
  await tx.widgetTrigger.deleteMany({ where: { flowId } });
  for (const trigger of payload.triggers ?? []) {
    await tx.widgetTrigger.create({
      data: {
        flowId,
        eventName: trigger.eventName,
        filter:
          trigger.filter == null
            ? Prisma.JsonNull
            : (trigger.filter as Prisma.InputJsonValue),
      },
    });
  }
}

/**
 * Recursively write an action subtree. Parent ids are resolved on the
 * fly because cuid() ids are assigned at create time — Prisma's
 * nested `create: { children: { create: [...] } }` shorthand wouldn't
 * give us back the parent id between create calls in a way that
 * scales past depth 2. Manual recursion is simpler + supports any
 * depth.
 */
async function writeActionTree(
  tx: ExtendedTransactionClient,
  flowId: string,
  parentId: string | null,
  actions: Array<{
    order: number;
    kind: string;
    config: Record<string, unknown>;
    children?: Array<{ order: number; kind: string; config: Record<string, unknown>; children?: unknown[] }>;
  }>,
): Promise<void> {
  for (const action of actions) {
    const created = await tx.widgetAction.create({
      data: {
        flowId,
        parentId,
        order: action.order,
        kind: action.kind,
        config: (action.config ?? {}) as Prisma.InputJsonValue,
      },
    });
    const children = action.children ?? [];
    if (children.length > 0) {
      await writeActionTree(
        tx,
        flowId,
        created.id,
        children as Parameters<typeof writeActionTree>[3],
      );
    }
  }
}

// Re-export Prisma's JsonNull so the controllers don't need to import
// it independently — keeps the type-conversion boilerplate local.
export { Prisma } from '@prisma/client';

// PrismaClient type re-export for callers building their own
// transactions outside this file.
export type { PrismaClient };

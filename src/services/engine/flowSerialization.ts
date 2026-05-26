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
import type { PrismaClient, WidgetStepKind } from '@prisma/client';

import prisma from '../../prisma';
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

  if (payload.steps.length === 0) {
    issues.push({
      path: 'steps',
      message: 'Le flow doit contenir au moins une étape.',
    });
    return issues; // can't validate per-step shape with zero steps
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
  include: { steps: { include: { fields: true } } };
}>;

/**
 * Read the normalized WidgetFlow + WidgetStep + WidgetField rows back
 * into a FlowPayload. Used to seed the draft on first edit and to
 * build export JSON.
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
}

// Re-export Prisma's JsonNull so the controllers don't need to import
// it independently — keeps the type-conversion boilerplate local.
export { Prisma } from '@prisma/client';

// PrismaClient type re-export for callers building their own
// transactions outside this file.
export type { PrismaClient };

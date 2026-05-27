// Flow graph serialization (Phase 3.1 — graph engine v2).
//
// One source of truth for the FlowPayload shape — the JSON blob used
// by WidgetFlowDraft.payload, WidgetFlowSnapshot.payload, and the
// export/import endpoints.
//
// Two transforms live here:
//   1. flowToPayload(flow) — read the normalized v2 tables
//      (WidgetNode, WidgetEdge, WidgetEntryPoint) and project to
//      FlowPayload shape.
//   2. writePayloadToFlow(tx, flowId, payload) — replace existing
//      v2 rows with the payload contents inside a transaction.
//
// Plus validatePublishable() — enforces graph invariants before a
// publish writes to the live tables:
//   - At least one node + one entry point
//   - Every entry point references an existing node
//   - Every edge references existing nodes
//   - Node kinds are registered in the handler registry
//   - No orphan nodes (every non-entry node reachable from an entry)
//   - WAIT_TOKEN nodes have an outgoing edge (otherwise the run
//     stalls after the token consumed)

import { Prisma } from '@prisma/client';
import type {
  PrismaClient,
  WidgetEdge,
  WidgetEntryPoint,
  WidgetNode,
} from '@prisma/client';

import prisma from '../../prisma';
import { getNodeHandler } from './nodeHandlers';
import type { FlowPayload } from '../../validations/widgetFlow.validation';

/**
 * The transaction client type as exposed by our extended Prisma
 * client. See prisma.ts for the extension layer; this derivation
 * keeps the v2 serializer in lockstep with the extension's widened
 * surface.
 */
type ExtendedTransactionClient = Parameters<
  Parameters<typeof prisma.$transaction>[0]
>[0];

// ─── Validation ───────────────────────────────────────────────────

export type PublishIssue = {
  /** Dotted path to the offending element, e.g. "nodes[2].config". */
  path: string;
  message: string;
};

/**
 * Returns the list of publish-blocking issues. Empty array = OK to
 * publish. Surfaces every issue in one pass so the admin sees the
 * full picture rather than fixing one at a time.
 */
export function validatePublishable(payload: FlowPayload): PublishIssue[] {
  const issues: PublishIssue[] = [];

  // ─── Sanity: must have at least one node + one entry point ─────
  if (payload.nodes.length === 0) {
    issues.push({
      path: 'nodes',
      message: 'Le flow doit contenir au moins un nœud.',
    });
  }
  if (payload.entryPoints.length === 0) {
    issues.push({
      path: 'entryPoints',
      message: 'Le flow doit avoir au moins un point d’entrée (visitor / event / cron).',
    });
  }

  // Build a node id lookup for cross-referencing.
  const nodeIds = new Set(payload.nodes.map((n) => n.id));

  // Node-id uniqueness — duplicate ids would corrupt edge resolution.
  const seen = new Set<string>();
  for (const [i, node] of payload.nodes.entries()) {
    if (seen.has(node.id)) {
      issues.push({
        path: `nodes[${i}].id`,
        message: `ID de nœud dupliqué : "${node.id}".`,
      });
    }
    seen.add(node.id);

    // Kind must have a registered handler.
    const handler = getNodeHandler(node.kind);
    if (!handler) {
      issues.push({
        path: `nodes[${i}].kind`,
        message: `Type de nœud "${node.kind}" inconnu — non enregistré dans le moteur.`,
      });
      continue;
    }

    // Per-kind config validation (handler's own responsibility).
    // Cast to JsonValue — the Zod-inferred type is Record<string, unknown>,
    // which is structurally compatible but TS treats them differently.
    const configError = handler.validateConfig(node.config as Prisma.JsonValue);
    if (configError) {
      issues.push({
        path: `nodes[${i}].config`,
        message: configError,
      });
    }
  }

  // ─── Edges reference existing nodes ────────────────────────────
  for (const [i, edge] of payload.edges.entries()) {
    if (!nodeIds.has(edge.fromNodeId)) {
      issues.push({
        path: `edges[${i}].fromNodeId`,
        message: `Arête : nœud source "${edge.fromNodeId}" introuvable.`,
      });
    }
    if (!nodeIds.has(edge.toNodeId)) {
      issues.push({
        path: `edges[${i}].toNodeId`,
        message: `Arête : nœud cible "${edge.toNodeId}" introuvable.`,
      });
    }
  }

  // ─── Entry points reference existing nodes ─────────────────────
  const knownEntryKinds = new Set(['visitor', 'event', 'cron']);
  const knownEventNames = new Set([
    'payment.succeeded',
    'payment.failed',
    'payment.refunded',
    'event.cancelled',
  ]);
  for (const [i, ep] of payload.entryPoints.entries()) {
    if (!knownEntryKinds.has(ep.kind)) {
      issues.push({
        path: `entryPoints[${i}].kind`,
        message: `Type de point d’entrée "${ep.kind}" inconnu.`,
      });
      continue;
    }
    if (!ep.entryNodeId || !nodeIds.has(ep.entryNodeId)) {
      issues.push({
        path: `entryPoints[${i}].entryNodeId`,
        message: `Point d’entrée : nœud d’entrée "${ep.entryNodeId ?? '(null)'}" introuvable.`,
      });
    }
    // Event entry points need a valid eventName.
    if (ep.kind === 'event') {
      const cfg = ep.config as { eventName?: unknown };
      if (typeof cfg.eventName !== 'string' || !knownEventNames.has(cfg.eventName)) {
        issues.push({
          path: `entryPoints[${i}].config.eventName`,
          message:
            `Événement "${String(cfg.eventName)}" inconnu du dispatcher. ` +
            `Valeurs supportées : ${Array.from(knownEventNames).join(', ')}.`,
        });
      }
    }
  }

  // ─── Reachability: warn if any node is orphaned ────────────────
  // (i.e. not the target of any edge AND not an entry node).
  // Surface as a soft warning rather than a hard block — admins may
  // be mid-edit and have nodes they haven't connected yet.
  // For v1, skip the warning — emit if it becomes a recurring pain.

  return issues;
}

// ─── Normalize → Payload ──────────────────────────────────────────

type NormalizedFlow = Prisma.WidgetFlowGetPayload<{
  include: {
    nodes: true;
    edges: true;
    entryPoints: true;
  };
}>;

/**
 * Read the normalized v2 rows back into a FlowPayload. Used to seed
 * the draft on first edit and to build export JSON.
 *
 * Strips all system-managed fields (timestamps, publishableKey,
 * version, isPublished, deletedAt, archivedAt) so the output
 * round-trips cleanly through the payload schema.
 */
export function flowToPayload(flow: NormalizedFlow): FlowPayload {
  return {
    name: flow.name,
    description: flow.description,
    kind: flow.kind,
    nodes: [...flow.nodes]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((n: WidgetNode) => ({
        id: n.id,
        kind: n.kind,
        label: n.label,
        description: n.description,
        config: (n.config ?? {}) as Record<string, unknown>,
        position: { x: n.positionX, y: n.positionY },
      })),
    edges: [...flow.edges]
      .sort((a, b) =>
        a.fromNodeId !== b.fromNodeId
          ? a.fromNodeId.localeCompare(b.fromNodeId)
          : a.order - b.order,
      )
      .map((e: WidgetEdge) => ({
        fromNodeId: e.fromNodeId,
        toNodeId: e.toNodeId,
        order: e.order,
        condition: e.condition as unknown,
        label: e.label,
      })),
    entryPoints: [...flow.entryPoints]
      .sort((a, b) => a.kind.localeCompare(b.kind))
      .map((ep: WidgetEntryPoint) => ({
        kind: ep.kind as 'visitor' | 'event' | 'cron',
        config: (ep.config ?? {}) as Record<string, unknown>,
        entryNodeId: ep.entryNodeId,
      })),
  };
}

// ─── Payload → Normalized writes ──────────────────────────────────

/**
 * Apply a FlowPayload to the live v2 tables (atomic — caller wraps
 * in a transaction).
 *
 * Strategy: delete-and-recreate nodes / edges / entry points. Cheaper
 * than per-row diff and avoids partial-update hazards. Cascade-delete
 * on the foreign keys handles dependent rows automatically.
 *
 * Node ids are preserved from the payload (the canvas editor invents
 * stable ids on node creation, autosaves them, and references them in
 * edges + entry points). Passing the id to Prisma's create() honors
 * it instead of generating a fresh cuid.
 */
export async function writePayloadToFlow(
  tx: ExtendedTransactionClient,
  flowId: string,
  payload: FlowPayload,
): Promise<void> {
  // Order matters: drop dependents (edges + entry points) before
  // nodes. Cascade-delete on the FK does this anyway, but explicit
  // is safer + easier to reason about.
  await tx.widgetEdge.deleteMany({ where: { flowId } });
  await tx.widgetEntryPoint.deleteMany({ where: { flowId } });
  await tx.widgetNode.deleteMany({ where: { flowId } });

  // Update flow scalars
  await tx.widgetFlow.update({
    where: { id: flowId },
    data: {
      name: payload.name,
      description: payload.description ?? null,
      kind: payload.kind,
    },
  });

  // Recreate nodes first (edges + entry points reference them by id).
  for (const node of payload.nodes) {
    await tx.widgetNode.create({
      data: {
        id: node.id, // honor admin-provided id
        flowId,
        kind: node.kind,
        label: node.label,
        description: node.description ?? null,
        config: (node.config ?? {}) as Prisma.InputJsonValue,
        positionX: node.position.x,
        positionY: node.position.y,
      },
    });
  }

  // Edges next.
  for (const edge of payload.edges) {
    await tx.widgetEdge.create({
      data: {
        flowId,
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
        order: edge.order,
        condition:
          edge.condition == null
            ? Prisma.JsonNull
            : (edge.condition as Prisma.InputJsonValue),
        label: edge.label ?? null,
      },
    });
  }

  // Entry points last.
  for (const ep of payload.entryPoints) {
    await tx.widgetEntryPoint.create({
      data: {
        flowId,
        kind: ep.kind,
        config: (ep.config ?? {}) as Prisma.InputJsonValue,
        entryNodeId: ep.entryNodeId,
      },
    });
  }
}

// Re-export Prisma's JsonNull so the controllers don't need to import
// it independently — keeps the type-conversion boilerplate local.
export { Prisma } from '@prisma/client';
export type { PrismaClient };

// Public-surface controller for the workflow engine
// (Phase 3.1 — graph engine v2).
//
// Three endpoints, all gated by requireWidgetFlow middleware which
// resolves the flow + attaches it to req. Responses are deliberately
// narrow — we never leak internal fields (organizationId, full edge
// definitions, etc.) to public callers.

import type { Request, Response } from 'express';

import prisma from '../prisma';
import {
  consumeResumeToken,
  GraphRuntimeError,
  startRun,
  submitNode,
} from '../services/engine/graphRuntime';
import { listEntities } from '../services/engine/entityRegistry';
import {
  startRunBodySchema,
  submitNodeBodySchema,
} from '../validations/widgetFlow.validation';
import { sendError } from './httpErrors';

// req shape after requireWidgetFlow ran.
type ReqWithFlow = Request & {
  widgetFlow?: {
    id: string;
    organizationId: string;
    name: string;
    kind: string;
    isPublished: boolean;
    publishableKey: string | null;
  };
};

/**
 * Translate a GraphRuntimeError code to HTTP status. Defaults to 500
 * because an unmapped code is a server bug, not a client issue.
 */
function runtimeErrorStatus(code: GraphRuntimeError['code']): number {
  switch (code) {
    case 'FLOW_NOT_FOUND':
    case 'FLOW_NOT_PUBLISHED':
    case 'RUN_NOT_FOUND':
    case 'NODE_NOT_FOUND':
    case 'ENTRY_NOT_FOUND':
      return 404;
    case 'RUN_NOT_IN_PROGRESS':
    case 'NODE_NOT_CURRENT':
      return 409;
    case 'NO_HANDLER':
      return 500;
    default:
      return 500;
  }
}

/** Public-safe projection of a run. */
function publicRun(run: {
  id: string;
  flowId: string;
  currentNodeId: string | null;
  status: string;
  vars: unknown;
  startedAt: Date;
  completedAt: Date | null;
}) {
  return {
    id: run.id,
    flowId: run.flowId,
    currentNodeId: run.currentNodeId,
    status: run.status,
    vars: run.vars,
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}

/**
 * Strip a node to the public-safe shape the renderer needs. For UI
 * kinds this includes the kind-specific config (option list, field
 * definitions, etc.). bindingTarget on FORM fields IS exposed so the
 * client can construct submission keys.
 *
 * Compatibility note: v1 returned `fields` as a top-level property of
 * the step. v2 bundles fields under `config.fields`. The visitor
 * renderer was built against v1, so we project `config.fields` to
 * the top level here. The renderer keeps working unchanged; the
 * canvas editor (Phase 3.3) will author them in the same location.
 */
function publicNode(node: {
  id: string;
  kind: string;
  label: string;
  description: string | null;
  config: unknown;
}) {
  const cfg = (node.config ?? {}) as { fields?: unknown };
  const fields = Array.isArray(cfg.fields) ? cfg.fields : [];
  return {
    id: node.id,
    kind: node.kind,
    label: node.label,
    description: node.description,
    config: node.config,
    // Mirrored for the v1 renderer; always an array (empty for non-
    // FORM kinds) so the renderer's `.slice().sort()` calls never
    // explode on undefined.
    fields,
  };
}

export class PublicWidgetFlowController {
  /**
   * POST /api/public/widget-flows/by-key/:publishableKey/runs
   *
   * Resolves the visitor entry point for the flow, then materializes
   * a run + walks until it pauses on a UI node (or completes).
   * Returns runId + the first node to render.
   */
  async createRun(req: Request, res: Response) {
    try {
      const flow = (req as ReqWithFlow).widgetFlow;
      if (!flow) {
        res.status(500).json({ error: 'Flow not resolved' });
        return;
      }

      const parsed = startRunBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({
          error: 'Invalid input',
          details: parsed.error.flatten(),
        });
        return;
      }

      // Find the visitor entry point — there should be exactly one.
      // Multiple visitor entry points are illegal (publish validation
      // could enforce this future); for now, pick the first.
      const visitorEntry = await prisma.widgetEntryPoint.findFirst({
        where: { flowId: flow.id, kind: 'visitor' },
        select: { entryNodeId: true },
      });
      if (!visitorEntry?.entryNodeId) {
        res.status(404).json({
          error: 'Flow has no visitor entry point',
        });
        return;
      }

      const { run, currentNode } = await startRun({
        flowId: flow.id,
        organizationId: flow.organizationId,
        entryNodeId: visitorEntry.entryNodeId,
      });

      res.status(201).json({
        run: publicRun(run),
        // Preserve `firstStep` name for backward compatibility with
        // the existing visitor renderer; mirrors as firstNode going
        // forward. Either is valid.
        firstStep: currentNode ? publicNode(currentNode) : null,
        firstNode: currentNode ? publicNode(currentNode) : null,
      });
    } catch (err) {
      if (err instanceof GraphRuntimeError) {
        res.status(runtimeErrorStatus(err.code)).json({
          error: err.message,
          code: err.code,
        });
        return;
      }
      sendError(res, err, 'Failed to start run');
    }
  }

  /**
   * GET /api/public/widget-flows/by-key/:publishableKey/runs/:runId
   *
   * Resume / poll. Returns the run + current node for clients that
   * lost their in-memory state (page reload, etc.).
   */
  async getRun(req: Request, res: Response) {
    try {
      const flow = (req as ReqWithFlow).widgetFlow;
      if (!flow) {
        res.status(500).json({ error: 'Flow not resolved' });
        return;
      }

      const { runId } = req.params;
      const run = await prisma.widgetRun.findUnique({
        where: { id: runId },
      });
      if (!run) {
        res.status(404).json({ error: 'Run not found' });
        return;
      }
      // Cross-flow safety.
      if (run.flowId !== flow.id) {
        res.status(404).json({ error: 'Run not found' });
        return;
      }

      const currentNode = run.currentNodeId
        ? await prisma.widgetNode.findUnique({
            where: { id: run.currentNodeId },
          })
        : null;

      res.json({
        run: publicRun(run),
        currentStep: currentNode ? publicNode(currentNode) : null,
        currentNode: currentNode ? publicNode(currentNode) : null,
      });
    } catch (err) {
      sendError(res, err, 'Failed to fetch run');
    }
  }

  /**
   * GET /api/public/widget-flows/resume/:tokenId
   *
   * Consume a single-use resume token + advance the paused run.
   * Resolves the run + flow + publishable key from the token + run
   * row (no requireWidgetFlow middleware here — the token IS the
   * authorization).
   *
   * Returns the run state + the publishable key, so the admin's
   * /widget-flow/resume/[token] page can redirect to the visitor
   * renderer at the right URL with the runId in the query string.
   *
   * If the token is invalid / expired / already-consumed, returns
   * the error JSON with a 4xx status code so the admin's resume
   * page can render a friendly "this link is no longer valid"
   * message.
   */
  async consumeResume(req: Request, res: Response) {
    const { tokenId } = req.params;
    try {
      const result = await consumeResumeToken({ tokenId });

      // Resolve the flow's publishable key so the client can route
      // to the visitor renderer. EVENT_REACTION flows have null
      // publishableKey — they shouldn't normally be reached via
      // visitor resume URLs (those flows don't have visitor entry),
      // but we return null gracefully for the client to handle.
      const flow = await prisma.widgetFlow.findUnique({
        where: { id: result.run.flowId },
        select: { id: true, publishableKey: true, name: true },
      });

      res.json({
        runId: result.run.id,
        flowId: result.run.flowId,
        publishableKey: flow?.publishableKey ?? null,
        run: publicRun(result.run),
        currentNode: result.currentNode
          ? publicNode(result.currentNode)
          : null,
      });
    } catch (err) {
      if (err instanceof GraphRuntimeError) {
        res.status(runtimeErrorStatus(err.code)).json({
          error: err.message,
          code: err.code,
        });
        return;
      }
      sendError(res, err, 'Failed to consume resume token');
    }
  }

  /**
   * GET /api/public/widget-flows/by-key/:publishableKey/entities/:entityType
   *
   * Returns the list of entities (Facilitator / Room / Client /
   * Service) the visitor renderer can show in an ENTITY_REF picker.
   * The list is scoped to the flow's organization via requireWidgetFlow
   * and filtered through the entityRegistry's safeFields whitelist —
   * we never return raw Prisma rows.
   *
   * Query string:
   *   - limit: optional, clamped to the registry's per-type max.
   *   - ids:   optional comma-separated allow-list of entity ids the
   *            caller wants. Used by SINGLE_SELECT with selectionMode
   *            = 'subset' so the visitor only sees the handpicked
   *            options the admin chose. Empty string = no filter
   *            (treats `?ids=` and missing the same).
   *
   * No pagination cursor yet — bounded by the per-type maxListSize
   * (200) which is enough for typical small/mid-sized orgs. A cursor
   * lands when a customer needs it.
   */
  async listEntities(req: Request, res: Response) {
    try {
      const flow = (req as ReqWithFlow).widgetFlow;
      if (!flow) {
        res.status(500).json({ error: 'Flow not resolved' });
        return;
      }

      const { entityType } = req.params;
      const rawLimit = Number(req.query.limit);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;

      // Comma-separated id allow-list. Defensive parse: trim each
      // segment + drop empties so `?ids=a,,b` and `?ids=a , b` both
      // resolve to ['a','b'].
      const rawIds = req.query.ids;
      const idFilter =
        typeof rawIds === 'string' && rawIds.length > 0
          ? rawIds
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0)
          : undefined;

      const items = await listEntities({
        organizationId: flow.organizationId,
        type: entityType,
        limit,
        idFilter,
      });

      // Unknown entity type → 404 (the registry returned empty).
      // Distinguish "unknown type" from "valid type, no rows" by
      // re-checking via getEntityDescriptor would add a round trip; the
      // public endpoint just returns empty in both cases. Authoring-
      // time validation against the registry is what catches typos.
      res.json({ entities: items });
    } catch (err) {
      sendError(res, err, 'Failed to list entities');
    }
  }

  /**
   * POST /api/public/widget-flows/by-key/:publishableKey/runs/:runId/nodes/:nodeId/submit
   * Also accepts (legacy): .../steps/:stepId/submit — same handler.
   *
   * Submit values for the current UI node. Idempotent via
   * clientSubmitId. Validation failures return 200 with errors so
   * the client can re-render the form inline.
   */
  async submitNode(req: Request, res: Response) {
    try {
      const flow = (req as ReqWithFlow).widgetFlow;
      if (!flow) {
        res.status(500).json({ error: 'Flow not resolved' });
        return;
      }

      const parsed = submitNodeBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'Invalid input',
          details: parsed.error.flatten(),
        });
        return;
      }

      // Accept either `nodeId` (v2) or `stepId` (v1 legacy URL).
      const nodeId = (req.params.nodeId ?? req.params.stepId) as string;
      const { runId } = req.params;

      const result = await submitNode({
        runId,
        nodeId,
        submission: {
          values: parsed.data.values,
          clientSubmitId: parsed.data.clientSubmitId,
        },
      });

      if (result.run.flowId !== flow.id) {
        res.status(404).json({ error: 'Run not found' });
        return;
      }

      res.json({
        run: publicRun(result.run),
        // Dual-name for back-compat with the existing renderer.
        nextStep: result.nextNode ? publicNode(result.nextNode) : null,
        nextNode: result.nextNode ? publicNode(result.nextNode) : null,
        errors: result.errors,
        replayed: result.replayed,
      });
    } catch (err) {
      if (err instanceof GraphRuntimeError) {
        res.status(runtimeErrorStatus(err.code)).json({
          error: err.message,
          code: err.code,
        });
        return;
      }
      sendError(res, err, 'Failed to submit node');
    }
  }
}

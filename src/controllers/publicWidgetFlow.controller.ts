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
  GraphRuntimeError,
  startRun,
  submitNode,
} from '../services/engine/graphRuntime';
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
 */
function publicNode(node: {
  id: string;
  kind: string;
  label: string;
  description: string | null;
  config: unknown;
}) {
  return {
    id: node.id,
    kind: node.kind,
    label: node.label,
    description: node.description,
    config: node.config,
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

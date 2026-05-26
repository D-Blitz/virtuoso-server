// Public-surface controller for the workflow engine
// (Phase 2.0 Commit 3).
//
// Three endpoints, all gated by requireWidgetFlow middleware which
// resolves the flow + attaches it to req. Responses are deliberately
// narrow — we never leak internal fields (organizationId, draft
// state, raw stepHistory) to public callers.

import type { Request, Response } from 'express';
import {
  EngineError,
  advanceStep,
  startRun,
  submitStep,
} from '../services/engine/flowEngine';
import {
  startRunBodySchema,
  submitStepBodySchema,
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
 * Translate an EngineError code to an HTTP status. Defaults to 500
 * because an unmapped code is a server bug, not a client issue.
 */
function engineErrorStatus(code: EngineError['code']): number {
  switch (code) {
    case 'FLOW_NOT_FOUND':
    case 'RUN_NOT_FOUND':
    case 'STEP_NOT_FOUND':
      return 404;
    case 'FLOW_NOT_PUBLISHED':
      return 404;
    case 'RUN_NOT_IN_PROGRESS':
    case 'STEP_NOT_CURRENT':
      return 409;
    case 'NO_HANDLER':
      return 500;
    default:
      return 500;
  }
}

/**
 * Strip the run shape down to public-safe fields. organizationId
 * and stepHistory are deliberately omitted — visitors don't need to
 * see the org id or internal analytics breadcrumbs.
 */
function publicRun(run: {
  id: string;
  flowId: string;
  currentStepId: string | null;
  status: string;
  vars: unknown;
  startedAt: Date;
  completedAt: Date | null;
}) {
  return {
    id: run.id,
    flowId: run.flowId,
    currentStepId: run.currentStepId,
    status: run.status,
    vars: run.vars,
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}

/**
 * Strip the step shape to the bare minimum the client renderer needs.
 * config + fields are preserved (the client needs them to render the
 * step), but order is normalized to a stable shape.
 */
function publicStep(step: {
  id: string;
  order: number;
  kind: string;
  label: string;
  description: string | null;
  config: unknown;
  fields: Array<{
    id: string;
    order: number;
    kind: string;
    label: string;
    placeholder: string | null;
    required: boolean;
    config: unknown;
  }>;
}) {
  return {
    id: step.id,
    order: step.order,
    kind: step.kind,
    label: step.label,
    description: step.description,
    config: step.config,
    fields: step.fields
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((f) => ({
        id: f.id,
        order: f.order,
        kind: f.kind,
        label: f.label,
        placeholder: f.placeholder,
        required: f.required,
        config: f.config,
      })),
  };
}

export class PublicWidgetFlowController {
  /**
   * POST /api/public/widget-flows/by-key/:publishableKey/runs
   *
   * Creates a fresh WidgetRun for the published flow. Returns the
   * runId + the first step the visitor should render.
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

      const { run, firstStep } = await startRun({
        flowId: flow.id,
        organizationId: flow.organizationId,
      });

      res.status(201).json({
        run: publicRun(run),
        firstStep: firstStep ? publicStep(firstStep) : null,
      });
    } catch (err) {
      if (err instanceof EngineError) {
        res.status(engineErrorStatus(err.code)).json({
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
   * Resume / poll. Returns the run + current step for clients that
   * lost their in-memory state (page reload, navigation away, etc.).
   */
  async getRun(req: Request, res: Response) {
    try {
      const flow = (req as ReqWithFlow).widgetFlow;
      if (!flow) {
        res.status(500).json({ error: 'Flow not resolved' });
        return;
      }

      const { runId } = req.params;
      const { run, currentStep } = await advanceStep({ runId });

      // Cross-flow safety: the runId could exist but belong to a
      // different flow's publishableKey. 404 instead of leaking the
      // mismatch.
      if (run.flowId !== flow.id) {
        res.status(404).json({ error: 'Run not found' });
        return;
      }

      res.json({
        run: publicRun(run),
        currentStep: currentStep ? publicStep(currentStep) : null,
      });
    } catch (err) {
      if (err instanceof EngineError) {
        res.status(engineErrorStatus(err.code)).json({
          error: err.message,
          code: err.code,
        });
        return;
      }
      sendError(res, err, 'Failed to fetch run');
    }
  }

  /**
   * POST /api/public/widget-flows/by-key/:publishableKey/runs/:runId/steps/:stepId/submit
   *
   * Submit values for the current step. Idempotent via clientSubmitId
   * — the engine handles dedupe at the DB level.
   *
   * Returns the (possibly-updated) run, the next step to render, and
   * any validation errors. Validation failures are NOT HTTP errors —
   * they return 200 with `errors: [...]` so the client can re-render
   * the form.
   */
  async submitStep(req: Request, res: Response) {
    try {
      const flow = (req as ReqWithFlow).widgetFlow;
      if (!flow) {
        res.status(500).json({ error: 'Flow not resolved' });
        return;
      }

      const parsed = submitStepBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'Invalid input',
          details: parsed.error.flatten(),
        });
        return;
      }

      const { runId, stepId } = req.params;

      const result = await submitStep({
        runId,
        stepId,
        submission: {
          values: parsed.data.values,
          clientSubmitId: parsed.data.clientSubmitId,
        },
      });

      // Cross-flow safety: same check as getRun above.
      if (result.run.flowId !== flow.id) {
        res.status(404).json({ error: 'Run not found' });
        return;
      }

      res.json({
        run: publicRun(result.run),
        nextStep: result.nextStep ? publicStep(result.nextStep) : null,
        errors: result.errors,
        replayed: result.replayed,
      });
    } catch (err) {
      if (err instanceof EngineError) {
        res.status(engineErrorStatus(err.code)).json({
          error: err.message,
          code: err.code,
        });
        return;
      }
      sendError(res, err, 'Failed to submit step');
    }
  }
}

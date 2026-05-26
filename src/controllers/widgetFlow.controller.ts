// Admin-surface controller for the workflow engine
// (Phase 2.0 Commit 3).
//
// Eight endpoints, all gated by requirePermission('WIDGET_MANAGE'):
//   GET    /flows            list
//   POST   /flows            create
//   GET    /flows/:id        get one
//   DELETE /flows/:id        delete (wipes runs)
//   GET    /flows/:id/draft  fetch autosave state
//   PATCH  /flows/:id/draft  save autosave state
//   POST   /flows/:id/publish    validate + ship
//   GET    /flows/:id/export     download JSON
//   POST   /flows/import         upload JSON → new flow

import type { Request, Response } from 'express';
import { getOrganizationId } from '../auth/context';
import {
  FlowAdminError,
  createFlow,
  deleteFlow,
  exportFlow,
  getDraft,
  getFlow,
  getUsageSummary,
  importFlow,
  listFlowRuns,
  listFlows,
  patchDraft,
  publishFlow,
} from '../services/engine/flowAdminService';
import {
  createFlowBodySchema,
  importFlowBodySchema,
  patchDraftBodySchema,
} from '../validations/widgetFlow.validation';
import { sendError } from './httpErrors';

/**
 * Translate FlowAdminError to a status. PUBLISH_BLOCKED returns 422
 * with the structured issue list — that's a "valid request, invalid
 * state" semantic, not a 400 (request was fine) or 409 (concurrent
 * modification). 422 is the unambiguous choice for "we understood,
 * we won't proceed."
 */
function flowAdminErrorStatus(code: FlowAdminError['code']): number {
  switch (code) {
    case 'NOT_FOUND':
      return 404;
    case 'NO_DRAFT':
      return 409;
    case 'PUBLISH_BLOCKED':
      return 422;
    default:
      return 500;
  }
}

function handleFlowAdminError(res: Response, err: unknown, fallback: string) {
  if (err instanceof FlowAdminError) {
    res.status(flowAdminErrorStatus(err.code)).json({
      error: err.message,
      code: err.code,
      ...(err.issues ? { issues: err.issues } : {}),
    });
    return;
  }
  sendError(res, err, fallback);
}

function requireOrgId(res: Response): string | null {
  const orgId = getOrganizationId();
  if (!orgId) {
    res.status(401).json({ error: 'Unauthenticated' });
    return null;
  }
  return orgId;
}

export class WidgetFlowController {
  async list(req: Request, res: Response) {
    const orgId = requireOrgId(res);
    if (!orgId) return;
    try {
      const flows = await listFlows(orgId);
      res.json({ flows });
    } catch (err) {
      handleFlowAdminError(res, err, 'Failed to list flows');
    }
  }

  async create(req: Request, res: Response) {
    const orgId = requireOrgId(res);
    if (!orgId) return;
    try {
      const parsed = createFlowBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'Invalid input',
          details: parsed.error.flatten(),
        });
        return;
      }
      const flow = await createFlow({
        organizationId: orgId,
        name: parsed.data.name,
        description: parsed.data.description,
        kind: parsed.data.kind,
      });
      res.status(201).json({ flow });
    } catch (err) {
      handleFlowAdminError(res, err, 'Failed to create flow');
    }
  }

  async getById(req: Request, res: Response) {
    const orgId = requireOrgId(res);
    if (!orgId) return;
    try {
      const flow = await getFlow(orgId, req.params.id);
      res.json({ flow });
    } catch (err) {
      handleFlowAdminError(res, err, 'Failed to fetch flow');
    }
  }

  async remove(req: Request, res: Response) {
    const orgId = requireOrgId(res);
    if (!orgId) return;
    try {
      await deleteFlow(orgId, req.params.id);
      res.status(204).send();
    } catch (err) {
      handleFlowAdminError(res, err, 'Failed to delete flow');
    }
  }

  async getDraft(req: Request, res: Response) {
    const orgId = requireOrgId(res);
    if (!orgId) return;
    try {
      const payload = await getDraft(orgId, req.params.id);
      res.json({ draft: payload });
    } catch (err) {
      handleFlowAdminError(res, err, 'Failed to fetch draft');
    }
  }

  async patchDraft(req: Request, res: Response) {
    const orgId = requireOrgId(res);
    if (!orgId) return;
    try {
      const parsed = patchDraftBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'Invalid input',
          details: parsed.error.flatten(),
        });
        return;
      }
      const draft = await patchDraft(orgId, req.params.id, parsed.data);
      res.json({
        draft: {
          flowId: draft.flowId,
          payload: draft.payload,
          updatedAt: draft.updatedAt.toISOString(),
        },
      });
    } catch (err) {
      handleFlowAdminError(res, err, 'Failed to save draft');
    }
  }

  async publish(req: Request, res: Response) {
    const orgId = requireOrgId(res);
    if (!orgId) return;
    try {
      const flow = await publishFlow(orgId, req.params.id);
      res.json({ flow });
    } catch (err) {
      handleFlowAdminError(res, err, 'Failed to publish flow');
    }
  }

  async exportFlow(req: Request, res: Response) {
    const orgId = requireOrgId(res);
    if (!orgId) return;
    try {
      const payload = await exportFlow(orgId, req.params.id);
      // Set Content-Disposition so browsers offer a download instead
      // of rendering JSON inline. Filename includes flow name, slug-
      // ified loosely so it's filesystem-safe across OSes.
      const slug = payload.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'flow';
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${slug}.flow.json"`,
      );
      res.setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify(payload, null, 2));
    } catch (err) {
      handleFlowAdminError(res, err, 'Failed to export flow');
    }
  }

  async importFlow(req: Request, res: Response) {
    const orgId = requireOrgId(res);
    if (!orgId) return;
    try {
      const parsed = importFlowBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'Invalid input',
          details: parsed.error.flatten(),
        });
        return;
      }
      const flow = await importFlow(orgId, parsed.data);
      res.status(201).json({ flow });
    } catch (err) {
      handleFlowAdminError(res, err, 'Failed to import flow');
    }
  }

  /** GET /api/widget-flows/:id/runs?limit=&offset= */
  async listRuns(req: Request, res: Response) {
    const orgId = requireOrgId(res);
    if (!orgId) return;
    try {
      const limit = req.query.limit
        ? Number.parseInt(req.query.limit as string, 10)
        : undefined;
      const offset = req.query.offset
        ? Number.parseInt(req.query.offset as string, 10)
        : undefined;
      const result = await listFlowRuns(orgId, req.params.id, {
        limit: Number.isFinite(limit) ? limit : undefined,
        offset: Number.isFinite(offset) ? offset : undefined,
      });
      res.json(result);
    } catch (err) {
      handleFlowAdminError(res, err, 'Failed to list runs');
    }
  }

  /** GET /api/widget-flows/usage/summary */
  async usageSummary(req: Request, res: Response) {
    const orgId = requireOrgId(res);
    if (!orgId) return;
    try {
      const summary = await getUsageSummary(orgId);
      res.json(summary);
    } catch (err) {
      handleFlowAdminError(res, err, 'Failed to fetch usage summary');
    }
  }
}

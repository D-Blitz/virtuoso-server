import { Request, Response } from 'express';
import { billingIdentityService } from '../services/billingIdentity/billingIdentity.service';
import { sendServiceError } from './httpErrors';

/**
 * Phase A — billing identities. The service throws plain
 * `Error & { statusCode }` for validation / not-found cases, so every
 * handler funnels through `sendServiceError` (honours the status code).
 */
export class BillingIdentityController {
  /** GET /api/billing-identities — all identities for the org. */
  async list(_req: Request, res: Response) {
    try {
      res.json(await billingIdentityService.list());
    } catch (err) {
      sendServiceError(res, err, 'Failed to list billing identities');
    }
  }

  /** GET /api/billing-identities/school — the SCHOOL singleton (or null). */
  async getSchool(_req: Request, res: Response) {
    try {
      res.json(await billingIdentityService.getSchool());
    } catch (err) {
      sendServiceError(res, err, 'Failed to load school billing identity');
    }
  }

  /** PUT /api/billing-identities/school — create-or-update the SCHOOL one. */
  async upsertSchool(req: Request, res: Response) {
    try {
      res.json(await billingIdentityService.upsertSchool(req.body ?? {}));
    } catch (err) {
      sendServiceError(res, err, 'Failed to save school billing identity');
    }
  }

  /** GET /api/billing-identities/facilitator/:facilitatorId */
  async getForFacilitator(req: Request, res: Response) {
    try {
      res.json(
        await billingIdentityService.getForFacilitator(req.params.facilitatorId),
      );
    } catch (err) {
      sendServiceError(res, err, 'Failed to load facilitator billing identity');
    }
  }

  /** PUT /api/billing-identities/facilitator/:facilitatorId */
  async upsertForFacilitator(req: Request, res: Response) {
    try {
      res.json(
        await billingIdentityService.upsertForFacilitator(
          req.params.facilitatorId,
          req.body ?? {},
        ),
      );
    } catch (err) {
      sendServiceError(res, err, 'Failed to save facilitator billing identity');
    }
  }
}

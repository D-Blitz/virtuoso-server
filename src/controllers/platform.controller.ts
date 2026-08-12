import { Request, Response } from 'express';

import { PlatformService } from '../services/platform/platform.service';
import { AccountSetupService } from '../services/platform/accountSetup.service';
import { sendError } from './httpErrors';

const platformService = new PlatformService();
const setupService = new AccountSetupService();

/**
 * Where the setup link should point. The API doesn't serve the page, so
 * it needs the admin app's public origin. ADMIN_ORIGINS is already the
 * CORS allowlist; its first entry is the canonical admin URL.
 */
function adminBaseUrl(): string {
  const first = (process.env.ADMIN_ORIGINS ?? 'http://localhost:3000')
    .split(',')[0]
    .trim();
  return first || 'http://localhost:3000';
}

export class PlatformController {
  /** GET /api/platform/organizations */
  async listOrganizations(_req: Request, res: Response) {
    try {
      res.json({ organizations: await platformService.listOrganizations() });
    } catch (error) {
      sendError(res, error, 'Failed to list organizations');
    }
  }

  /** POST /api/platform/organizations */
  async createOrganization(req: Request, res: Response) {
    try {
      const { slug, name, ownerEmail } = req.body ?? {};
      if (
        typeof slug !== 'string' ||
        typeof name !== 'string' ||
        typeof ownerEmail !== 'string'
      ) {
        res
          .status(400)
          .json({ error: 'slug, name et ownerEmail sont requis.' });
        return;
      }
      const result = await platformService.createOrganization({
        slug,
        name,
        ownerEmail,
        appBaseUrl: adminBaseUrl(),
      });
      res.status(201).json(result);
    } catch (error) {
      sendError(res, error, 'Failed to create organization');
    }
  }

  /** GET /api/public/account-setup/:token — unauthenticated. */
  async inspectSetupToken(req: Request, res: Response) {
    try {
      res.json(await setupService.inspect(req.params.token));
    } catch (error) {
      sendError(res, error, 'Invalid setup token');
    }
  }

  /** POST /api/public/account-setup/:token — unauthenticated. */
  async completeSetup(req: Request, res: Response) {
    try {
      const { password } = req.body ?? {};
      await setupService.complete(req.params.token, password);
      res.json({ ok: true });
    } catch (error) {
      sendError(res, error, 'Failed to set password');
    }
  }
}

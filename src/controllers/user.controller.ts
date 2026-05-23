import { Request, Response } from 'express';
import { UserService } from '../services/user/user.service';
import { sendError } from './httpErrors';

const service = new UserService();

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function asStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === 'string') as string[];
}

export class UserController {
  /** GET /api/users?includeDisabled=true */
  async list(req: Request, res: Response) {
    try {
      const includeDisabled = req.query.includeDisabled === 'true';
      const items = await service.list({ includeDisabled });
      res.json({ items });
    } catch (err) {
      sendError(res, err, 'Failed to list users');
    }
  }

  /** GET /api/users/me — current authenticated user + permissions */
  async me(_req: Request, res: Response) {
    try {
      const me = await service.getMe();
      if (!me) {
        res.status(404).json({ error: 'Utilisateur introuvable.' });
        return;
      }
      res.json(me);
    } catch (err) {
      sendError(res, err, 'Failed to load current user');
    }
  }

  /** GET /api/users/:id */
  async getById(req: Request, res: Response) {
    try {
      const row = await service.getById(req.params.id);
      if (!row) {
        res.status(404).json({ error: 'Utilisateur introuvable.' });
        return;
      }
      res.json(row);
    } catch (err) {
      sendError(res, err, 'Failed to load user');
    }
  }

  /** POST /api/users */
  async create(req: Request, res: Response) {
    try {
      const {
        email,
        password,
        roleId,
        facilitatorId,
        manageableFacilitatorIds,
        manageableLocationIds,
        manageableRoomIds,
      } = req.body ?? {};
      if (typeof email !== 'string' || typeof password !== 'string') {
        res
          .status(400)
          .json({ error: "L'email et le mot de passe sont requis." });
        return;
      }
      const row = await service.create({
        email,
        password,
        roleId: asString(roleId) ?? null,
        facilitatorId: asString(facilitatorId) ?? null,
        manageableFacilitatorIds: asStringList(manageableFacilitatorIds),
        manageableLocationIds: asStringList(manageableLocationIds),
        manageableRoomIds: asStringList(manageableRoomIds),
      });
      res.status(201).json(row);
    } catch (err) {
      sendError(res, err, 'Failed to create user');
    }
  }

  /** PUT /api/users/:id */
  async update(req: Request, res: Response) {
    try {
      const {
        email,
        roleId,
        facilitatorId,
        manageableFacilitatorIds,
        manageableLocationIds,
        manageableRoomIds,
      } = req.body ?? {};
      const row = await service.update(req.params.id, {
        email: asString(email),
        // roleId / facilitatorId distinguish "not in body" (undefined)
        // from "explicitly null" (unassign) — null comes through JSON.
        roleId:
          roleId === undefined ? undefined : (asString(roleId) ?? null),
        facilitatorId:
          facilitatorId === undefined
            ? undefined
            : (asString(facilitatorId) ?? null),
        // Per-dimension scope rewrites — undefined means "leave this
        // dimension alone", explicit array (even []) means "rewrite".
        manageableFacilitatorIds:
          manageableFacilitatorIds === undefined
            ? undefined
            : asStringList(manageableFacilitatorIds),
        manageableLocationIds:
          manageableLocationIds === undefined
            ? undefined
            : asStringList(manageableLocationIds),
        manageableRoomIds:
          manageableRoomIds === undefined
            ? undefined
            : asStringList(manageableRoomIds),
      });
      res.json(row);
    } catch (err) {
      sendError(res, err, 'Failed to update user');
    }
  }

  /** POST /api/users/:id/password */
  async changePassword(req: Request, res: Response) {
    try {
      const { password } = req.body ?? {};
      if (typeof password !== 'string') {
        res.status(400).json({ error: 'Le mot de passe est requis.' });
        return;
      }
      await service.changePassword(req.params.id, password);
      res.status(204).send();
    } catch (err) {
      sendError(res, err, 'Failed to change password');
    }
  }

  /** POST /api/users/:id/disable */
  async disable(req: Request, res: Response) {
    try {
      await service.disable(req.params.id);
      res.status(204).send();
    } catch (err) {
      sendError(res, err, 'Failed to disable user');
    }
  }

  /** POST /api/users/:id/reactivate */
  async reactivate(req: Request, res: Response) {
    try {
      await service.reactivate(req.params.id);
      res.status(204).send();
    } catch (err) {
      sendError(res, err, 'Failed to reactivate user');
    }
  }
}

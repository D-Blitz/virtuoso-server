import { Request, Response } from 'express';
import type { Permission } from '@prisma/client';
import { RoleService } from '../services/role/role.service';
import { sendError } from './httpErrors';

const service = new RoleService();

function parsePermissions(raw: unknown): Permission[] | null {
  if (!Array.isArray(raw)) return null;
  // Trust Prisma's enum runtime check — invalid values throw at the
  // service layer; we just enforce shape here.
  return raw.filter((p) => typeof p === 'string') as Permission[];
}

export class RoleController {
  /** GET /api/roles */
  async list(_req: Request, res: Response) {
    try {
      const items = await service.list();
      res.json({ items });
    } catch (err) {
      sendError(res, err, 'Failed to list roles');
    }
  }

  /** GET /api/roles/:id */
  async getById(req: Request, res: Response) {
    try {
      const row = await service.getById(req.params.id);
      if (!row) {
        res.status(404).json({ error: 'Rôle introuvable.' });
        return;
      }
      res.json(row);
    } catch (err) {
      sendError(res, err, 'Failed to load role');
    }
  }

  /** POST /api/roles */
  async create(req: Request, res: Response) {
    try {
      const { name, description, color, permissions } = req.body ?? {};
      if (typeof name !== 'string') {
        res.status(400).json({ error: 'Le nom du rôle est requis.' });
        return;
      }
      const parsedPerms = parsePermissions(permissions);
      if (parsedPerms === null) {
        res.status(400).json({ error: '`permissions` doit être un tableau.' });
        return;
      }
      const row = await service.create({
        name,
        description: typeof description === 'string' ? description : null,
        color: typeof color === 'string' ? color : null,
        permissions: parsedPerms,
      });
      res.status(201).json(row);
    } catch (err) {
      sendError(res, err, 'Failed to create role');
    }
  }

  /** PUT /api/roles/:id */
  async update(req: Request, res: Response) {
    try {
      const { name, description, color, permissions } = req.body ?? {};
      let parsedPerms: Permission[] | undefined;
      if (permissions !== undefined) {
        const p = parsePermissions(permissions);
        if (p === null) {
          res.status(400).json({ error: '`permissions` doit être un tableau.' });
          return;
        }
        parsedPerms = p;
      }
      const row = await service.update(req.params.id, {
        name: typeof name === 'string' ? name : undefined,
        description: typeof description === 'string' ? description : undefined,
        color: typeof color === 'string' ? color : undefined,
        permissions: parsedPerms,
      });
      res.json(row);
    } catch (err) {
      sendError(res, err, 'Failed to update role');
    }
  }

  /** DELETE /api/roles/:id */
  async remove(req: Request, res: Response) {
    try {
      await service.remove(req.params.id);
      res.status(204).send();
    } catch (err) {
      sendError(res, err, 'Failed to delete role');
    }
  }
}

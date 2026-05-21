import { Request, Response } from 'express';
import { TagService } from '../services/tag.service';
import { sendError } from './httpErrors';

const tagService = new TagService();

export class TagController {
  async create(req: Request, res: Response) {
    try {
      const tag = await tagService.create(req.body);
      res.status(201).json(tag);
    } catch (error) {
      sendError(res, error, 'Failed to create tag');
    }
  }

  async getAll(_req: Request, res: Response) {
    try {
      const tags = await tagService.getAll();
      res.json(tags);
    } catch (error) {
      sendError(res, error, 'Failed to fetch tags');
    }
  }

  async update(req: Request, res: Response) {
    const { id } = req.params;
    try {
      const updated = await tagService.update(id, req.body);
      res.json(updated);
    } catch (error) {
      sendError(res, error, 'Failed to update tag');
    }
  }

  async remove(req: Request, res: Response) {
    const { id } = req.params;
    try {
      await tagService.delete(id);
      res.status(204).send();
    } catch (error) {
      sendError(res, error, 'Failed to delete tag');
    }
  }
}

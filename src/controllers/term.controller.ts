import { Request, Response } from 'express';
import { TermService } from '../services/term.service';

const termService = new TermService();

export class TermController {
  async create(req: Request, res: Response) {
    try {
      const term = await termService.create(req.body);
      res.status(201).json(term);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to create term' });
    }
  }

  async getAll(_req: Request, res: Response) {
    try {
      const terms = await termService.getAll();
      res.json(terms);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to fetch terms' });
    }
  }

  async update(req: Request, res: Response) {
    const { id } = req.params;

    try {
      const updated = await termService.update(id, req.body);
      res.json(updated);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to update term' });
    }
  }

  async remove(req: Request, res: Response) {
    const { id } = req.params;

    try {
      await termService.delete(id);
      res.status(204).send();
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to delete term' });
    }
  }
}

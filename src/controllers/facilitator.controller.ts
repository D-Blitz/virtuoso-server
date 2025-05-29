import { Request, Response } from 'express';
import { FacilitatorService } from '../services/facilitator.service';

const facilitatorService = new FacilitatorService();

export class FacilitatorController {
  async create(req: Request, res: Response) {
    try {
      const facilitator = await facilitatorService.create(req.body);
      res.status(201).json(facilitator);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to create facilitator' });
    }
  }

  async getAll(_req: Request, res: Response) {
    try {
      const facilitators = await facilitatorService.getAll();
      res.json(facilitators);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to fetch facilitators' });
    }
  }

  async update(req: Request, res: Response) {
    const { id } = req.params;
    try {
      const updated = await facilitatorService.update(id, req.body);
      res.json(updated);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to update facilitator' });
    }
  }

  async remove(req: Request, res: Response) {
    const { id } = req.params;
    try {
      await facilitatorService.delete(id);
      res.status(204).send();
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to delete facilitator' });
    }
  }
}

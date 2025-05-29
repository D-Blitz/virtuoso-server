import { Request, Response } from 'express';
import { LocationService } from '../services/location.service';

const locationService = new LocationService();

export class LocationController {
  async create(req: Request, res: Response) {
    try {
      const location = await locationService.create(req.body);
      res.status(201).json(location);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to create location' });
    }
  }

  async getAll(_req: Request, res: Response) {
    try {
      const locations = await locationService.getAll();
      res.json(locations);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to fetch locations' });
    }
  }

  async update(req: Request, res: Response) {
    const { id } = req.params;
    try {
      const updated = await locationService.update(id, req.body);
      res.json(updated);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to update location' });
    }
  }

  async remove(req: Request, res: Response) {
    const { id } = req.params;
    try {
      await locationService.delete(id);
      res.status(204).send();
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to delete location' });
    }
  }
}

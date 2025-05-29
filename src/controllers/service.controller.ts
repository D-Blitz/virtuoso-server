import { Request, Response } from 'express';
import { ServiceService } from '../services/service.service';

const serviceService = new ServiceService();

export class ServiceController {
  async create(req: Request, res: Response) {
    try {
      const service = await serviceService.create(req.body);
      res.status(201).json(service);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to create service' });
    }
  }

  async getAll(_req: Request, res: Response) {
    try {
      const services = await serviceService.getAll();
      res.json(services);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to fetch services' });
    }
  }

  async update(req: Request, res: Response) {
    const { id } = req.params;
    try {
      const updated = await serviceService.update(id, req.body);
      res.json(updated);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to update service' });
    }
  }

  async remove(req: Request, res: Response) {
    const { id } = req.params;
    try {
      await serviceService.delete(id);
      res.status(204).send();
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to delete service' });
    }
  }
}
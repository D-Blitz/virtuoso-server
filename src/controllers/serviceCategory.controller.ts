import { Request, Response } from 'express';
import { ServiceCategoryService } from '../services/serviceCategory.service';

const serviceCategoryService = new ServiceCategoryService();

export class ServiceCategoryController {
  async create(req: Request, res: Response) {
    try {
      const category = await serviceCategoryService.create(req.body);
      res.status(201).json(category);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to create service category' });
    }
  }

  async getAll(_req: Request, res: Response) {
    try {
      const categories = await serviceCategoryService.getAll();
      res.json(categories);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to fetch service categories' });
    }
  }

  async update(req: Request, res: Response) {
    const { id } = req.params;
    try {
      const updated = await serviceCategoryService.update(id, req.body);
      res.json(updated);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to update service category' });
    }
  }

  async remove(req: Request, res: Response) {
    const { id } = req.params;
    try {
      await serviceCategoryService.delete(id);
      res.status(204).send();
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to delete service category' });
    }
  }
}
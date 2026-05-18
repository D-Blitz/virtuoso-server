import { Request, Response } from 'express';
import { WidgetService } from '../services/widget.service';

const widgetService = new WidgetService();

export class WidgetController {
  async list(_req: Request, res: Response) {
    try {
      const widgets = await widgetService.list();
      res.json(widgets);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to fetch widgets' });
    }
  }

  async getById(req: Request, res: Response) {
    try {
      const widget = await widgetService.getById(req.params.id);
      if (!widget) {
        res.status(404).json({ error: 'Widget not found' });
        return;
      }
      res.json(widget);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to fetch widget' });
    }
  }

  async create(req: Request, res: Response) {
    try {
      const { slug } = req.body ?? {};
      if (typeof slug !== 'string' || slug.trim().length === 0) {
        res.status(400).json({ error: 'slug is required' });
        return;
      }
      const widget = await widgetService.create(req.body);
      res.status(201).json(widget);
    } catch (error: any) {
      console.error(error);
      if (error?.code === 'P2002') {
        res.status(409).json({ error: 'Slug already used in this organization' });
        return;
      }
      res.status(500).json({ error: 'Failed to create widget' });
    }
  }

  async update(req: Request, res: Response) {
    try {
      const widget = await widgetService.update(req.params.id, req.body);
      res.json(widget);
    } catch (error: any) {
      console.error(error);
      if (error?.code === 'P2002') {
        res.status(409).json({ error: 'Slug already used in this organization' });
        return;
      }
      if (error?.code === 'P2025') {
        res.status(404).json({ error: 'Widget not found' });
        return;
      }
      res.status(500).json({ error: 'Failed to update widget' });
    }
  }

  async publish(req: Request, res: Response) {
    try {
      const widget = await widgetService.publish(req.params.id);
      res.json(widget);
    } catch (error: any) {
      console.error(error);
      if (error?.message === 'Widget not found' || error?.code === 'P2025') {
        res.status(404).json({ error: 'Widget not found' });
        return;
      }
      res.status(500).json({ error: 'Failed to publish widget' });
    }
  }

  async unpublish(req: Request, res: Response) {
    try {
      const widget = await widgetService.unpublish(req.params.id);
      res.json(widget);
    } catch (error: any) {
      console.error(error);
      if (error?.code === 'P2025') {
        res.status(404).json({ error: 'Widget not found' });
        return;
      }
      res.status(500).json({ error: 'Failed to unpublish widget' });
    }
  }

  async remove(req: Request, res: Response) {
    try {
      await widgetService.delete(req.params.id);
      res.status(204).send();
    } catch (error: any) {
      console.error(error);
      if (error?.code === 'P2025') {
        res.status(404).json({ error: 'Widget not found' });
        return;
      }
      res.status(500).json({ error: 'Failed to delete widget' });
    }
  }
}

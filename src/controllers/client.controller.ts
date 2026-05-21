import { Request, Response } from 'express';
import { ClientService } from '../services/client.service';
import { sendError } from './httpErrors';

const clientService = new ClientService();

export class ClientController {
  async create(req: Request, res: Response) {
    try {
      const client = await clientService.create(req.body);
      res.status(201).json(client);
    } catch (error) {
      sendError(res, error, 'Failed to create client');
    }
  }

  async getAll(_req: Request, res: Response) {
    try {
      const clients = await clientService.getAll();
      res.json(clients);
    } catch (error) {
      sendError(res, error, 'Failed to fetch clients');
    }
  }

  async update(req: Request, res: Response) {
    const { id } = req.params;
    try {
      const updated = await clientService.update(id, req.body);
      res.json(updated);
    } catch (error) {
      sendError(res, error, 'Failed to update client');
    }
  }

  async remove(req: Request, res: Response) {
    const { id } = req.params;
    try {
      await clientService.delete(id);
      res.status(204).send();
    } catch (error) {
      sendError(res, error, 'Failed to delete client');
    }
  }
}

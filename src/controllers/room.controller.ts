import { Request, Response } from 'express';
import { RoomService } from '../services/room.service';

const roomService = new RoomService();

export class RoomController {
  async create(req: Request, res: Response) {
    try {
      const room = await roomService.create(req.body);
      res.status(201).json(room);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to create room' });
    }
  }

  async getAll(_req: Request, res: Response) {
    try {
      const rooms = await roomService.getAll();
      res.json(rooms);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to fetch rooms' });
    }
  }

  async update(req: Request, res: Response) {
    const { id } = req.params;
    try {
      const updated = await roomService.update(id, req.body);
      res.json(updated);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to update room' });
    }
  }

  async remove(req: Request, res: Response) {
    const { id } = req.params;
    try {
      await roomService.delete(id);
      res.status(204).send();
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to delete room' });
    }
  }
}

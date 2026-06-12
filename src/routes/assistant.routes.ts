import { Router, Request, Response } from 'express';

import { AssistantService } from '../services/assistant/assistant.service';
import { sendServiceError } from '../controllers/httpErrors';

const router = Router();
const service = new AssistantService();

/** POST /api/assistant/chat { messages: [{role, content}] } */
router.post('/chat', async (req: Request, res: Response) => {
  try {
    const raw = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const messages = raw
      .filter(
        (m: unknown): m is { role: string; content: string } =>
          !!m &&
          typeof (m as { content?: unknown }).content === 'string' &&
          ((m as { role?: unknown }).role === 'user' ||
            (m as { role?: unknown }).role === 'assistant'),
      )
      .map((m: { role: string; content: string }) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content.slice(0, 4000),
      }));
    if (!messages.length || messages[messages.length - 1].role !== 'user') {
      res.status(400).json({ error: 'messages must end with a user turn' });
      return;
    }
    const reply = await service.chat(messages);
    res.json({ reply });
  } catch (err) {
    sendServiceError(res, err, 'Assistant chat failed');
  }
});

export default router;

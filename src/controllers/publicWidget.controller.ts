import { Request, Response } from 'express';
import { PublicWidgetService } from '../services/publicWidget.service';
import { RecommenderService } from '../services/recommender.service';
import { AvailabilityService } from '../services/availability.service';
import { SlotHoldService } from '../services/slotHold.service';
import { TrialBookingService } from '../services/trialBooking.service';
import {
  recommendationsBodySchema,
  availabilityQuerySchema,
  createHoldBodySchema,
  trialBookingBodySchema,
} from '../validations/publicWidget.validation';

const publicWidgetService = new PublicWidgetService();
const recommenderService = new RecommenderService();
const availabilityService = new AvailabilityService();
const slotHoldService = new SlotHoldService();
const trialBookingService = new TrialBookingService();

type RecommenderWeights = {
  ageMatch: number;
  levelMatch: number;
  priorityWeightMultiplier: number;
};

function getWidgetWeights(widget: { publishedConfig: unknown }): RecommenderWeights {
  const cfg = widget.publishedConfig as
    | { recommenderWeights?: Partial<RecommenderWeights> }
    | null;
  const w = cfg?.recommenderWeights ?? {};
  return {
    ageMatch: typeof w.ageMatch === 'number' ? w.ageMatch : 1,
    levelMatch: typeof w.levelMatch === 'number' ? w.levelMatch : 1,
    priorityWeightMultiplier:
      typeof w.priorityWeightMultiplier === 'number'
        ? w.priorityWeightMultiplier
        : 1,
  };
}

export class PublicWidgetController {
  async getConfig(req: Request, res: Response) {
    try {
      const widget = (req as Request & { widget?: any }).widget;
      if (!widget) {
        res.status(500).json({ error: 'Widget not resolved' });
        return;
      }

      const payload = await publicWidgetService.getConfig(widget);
      if (!payload) {
        res.status(404).json({ error: 'Widget is not published yet' });
        return;
      }
      res.json(payload);
    } catch (error) {
      console.error('public widget config error:', error);
      res.status(500).json({ error: 'Failed to fetch widget config' });
    }
  }

  async recommendations(req: Request, res: Response) {
    try {
      const widget = (req as Request & { widget?: any }).widget;
      if (!widget) {
        res.status(500).json({ error: 'Widget not resolved' });
        return;
      }

      const parsed = recommendationsBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: 'Invalid input', details: parsed.error.flatten() });
        return;
      }

      const result = await recommenderService.recommend({
        ...parsed.data,
        weights: getWidgetWeights(widget),
      });
      res.json(result);
    } catch (error) {
      console.error('recommendations error:', error);
      res.status(500).json({ error: 'Failed to compute recommendations' });
    }
  }

  async availability(req: Request, res: Response) {
    try {
      const parsed = availabilityQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: 'Invalid query', details: parsed.error.flatten() });
        return;
      }
      const slots = await availabilityService.getAvailableSlots({
        serviceId: parsed.data.serviceId,
        facilitatorIds: parsed.data.facilitatorIds,
        from: new Date(parsed.data.from),
        to: new Date(parsed.data.to),
        locationId: parsed.data.locationId,
      });
      res.json({ slots });
    } catch (error) {
      console.error('availability error:', error);
      res.status(500).json({ error: 'Failed to compute availability' });
    }
  }

  async createHold(req: Request, res: Response) {
    try {
      const parsed = createHoldBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: 'Invalid input', details: parsed.error.flatten() });
        return;
      }
      const result = await slotHoldService.create({
        facilitatorId: parsed.data.facilitatorId,
        startTime: new Date(parsed.data.startTime),
        endTime: new Date(parsed.data.endTime),
        sessionId: parsed.data.sessionId,
      });
      if (!result.ok) {
        res.status(result.reason === 'CONFLICT' ? 409 : 400).json({
          error: result.reason === 'CONFLICT' ? 'Slot conflict' : 'Invalid hold',
        });
        return;
      }
      res.status(201).json({
        holdId: result.hold.id,
        expiresAt: result.hold.expiresAt.toISOString(),
      });
    } catch (error) {
      console.error('createHold error:', error);
      res.status(500).json({ error: 'Failed to create hold' });
    }
  }

  async releaseHold(req: Request, res: Response) {
    try {
      const sessionId =
        (req.query.sessionId as string) || (req.body?.sessionId as string);
      if (!sessionId) {
        res.status(400).json({ error: 'sessionId required' });
        return;
      }
      const result = await slotHoldService.release(req.params.holdId, sessionId);
      if (!result.ok) {
        res.status(404).json({ error: 'Hold not found or already consumed' });
        return;
      }
      res.status(204).send();
    } catch (error) {
      console.error('releaseHold error:', error);
      res.status(500).json({ error: 'Failed to release hold' });
    }
  }

  async createTrialBooking(req: Request, res: Response) {
    try {
      const widget = (req as Request & { widget?: any }).widget;
      if (!widget) {
        res.status(500).json({ error: 'Widget not resolved' });
        return;
      }

      const parsed = trialBookingBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: 'Invalid input', details: parsed.error.flatten() });
        return;
      }

      const result = await trialBookingService.submit({
        widgetId: widget.id,
        organizationId: widget.organizationId,
        holdId: parsed.data.holdId,
        sessionId: parsed.data.sessionId,
        serviceId: parsed.data.serviceId,
        facilitatorId: parsed.data.facilitatorId,
        startTime: new Date(parsed.data.startTime),
        endTime: new Date(parsed.data.endTime),
        student: parsed.data.student,
        languages: parsed.data.languages,
        level: parsed.data.level,
        acceptedCgv: parsed.data.acceptedCgv,
        cgvVersion: parsed.data.cgvVersion,
        marketingOptIn: parsed.data.marketingOptIn,
        ip:
          (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
          req.socket.remoteAddress ||
          undefined,
        userAgent: req.headers['user-agent'] || undefined,
      });

      res.status(201).json(result);
    } catch (error) {
      console.error('trial booking error:', error);
      const msg = error instanceof Error ? error.message : 'Unknown error';
      const status =
        msg.toLowerCase().includes('expired') || msg.toLowerCase().includes('invalid')
          ? 409
          : 400;
      res.status(status).json({ error: msg });
    }
  }

  async getTrialBooking(req: Request, res: Response) {
    try {
      const submissionId = req.params.submissionId;
      const data = await trialBookingService.getStatus(submissionId);
      if (!data) {
        res.status(404).json({ error: 'Submission not found' });
        return;
      }
      res.json(data);
    } catch (error) {
      console.error('getTrialBooking error:', error);
      res.status(500).json({ error: 'Failed to fetch trial booking status' });
    }
  }
}

import { Router } from 'express';
import {
  getPublicVenues,
  getPublicFacilitators,
} from '../services/publicMarketplace.service';

const router = Router();

// GET /api/public/marketplace/venues
router.get('/venues', async (_req, res) => {
  try {
    res.json(await getPublicVenues());
  } catch (err) {
    console.error('[public/marketplace] venues failed', err);
    res.status(500).json({ error: 'Failed to load venues' });
  }
});

// GET /api/public/marketplace/facilitators
router.get('/facilitators', async (_req, res) => {
  try {
    res.json(await getPublicFacilitators());
  } catch (err) {
    console.error('[public/marketplace] facilitators failed', err);
    res.status(500).json({ error: 'Failed to load facilitators' });
  }
});

export default router;

import { Router } from 'express';
import {
  getPublicVenues,
  getPublicFacilitators,
  getPublicVenueDetail,
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

// GET /api/public/marketplace/venues/:id  — single venue detail
router.get('/venues/:id', async (req, res) => {
  try {
    const venue = await getPublicVenueDetail(req.params.id);
    if (!venue) {
      res.status(404).json({ error: 'Venue not found' });
      return;
    }
    res.json(venue);
  } catch (err) {
    console.error('[public/marketplace] venue detail failed', err);
    res.status(500).json({ error: 'Failed to load venue' });
  }
});

export default router;

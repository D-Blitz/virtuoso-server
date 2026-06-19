import { Router } from 'express';
import { createHash } from 'crypto';

const router = Router();

/**
 * POST /api/cloudinary/signature
 *
 * Returns params for a signed, direct browser->Cloudinary upload so the API
 * secret never leaves the server. Mounted behind requireUser (admin only).
 *
 * Requires CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET
 * in the environment.
 */
router.post('/signature', (_req, res) => {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    res.status(500).json({ error: 'Cloudinary is not configured on the server' });
    return;
  }

  const timestamp = Math.round(Date.now() / 1000);
  const folder = 'artcetera/marketplace';

  // Cloudinary signed upload: SHA-1 of the alphabetically-sorted params to
  // sign, concatenated with the API secret.
  const signature = createHash('sha1')
    .update(`folder=${folder}&timestamp=${timestamp}${apiSecret}`)
    .digest('hex');

  res.json({ cloudName, apiKey, timestamp, folder, signature });
});

export default router;

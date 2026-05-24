// Load .env BEFORE any other import so top-level code in imported
// modules sees the env vars. The previous `dotenv.config()` call at the
// bottom of this file ran AFTER imports — fine for lazy reads but a
// latent footgun for any module that reads env at import time.
import 'dotenv/config';

import express from 'express';
import cors from 'cors';

// auth
import { requireUser } from './middleware/auth';
import authRoutes from './routes/auth.routes';
import publicWidgetRoutes from './routes/publicWidget.routes';
import publicInviteRoutes from './routes/publicInvite.routes';
import publicRescheduleRoutes from './routes/publicReschedule.routes';
import webhookRoutes from './routes/webhook.routes';

// routes
import facilitatorRoutes from './routes/facilitator.routes';
import roomRoutes from './routes/room.routes';
import serviceRoutes from './routes/service.routes';
import tagRoutes from './routes/tag.routes';
import clientRoutes from './routes/client.routes';
import serviceCategoryRoutes from './routes/serviceCategory.routes';
import scheduledEventRoutes from './routes/scheduledEvent.routes';
import locationRoutes from './routes/location.routes';
import termRoutes from './routes/term.routes';
import enrollmentRoutes from './routes/enrollment.routes';
import contextRoutes from './routes/context.routes';
import scheduledEventValidationRoutes from './routes/validation/scheduledEventValidation.routes';
import enrollmentEngineRoutes from './routes/enrollmentEngine.routes';
import widgetRoutes from './routes/widget.routes';
import paymentRoutes from './routes/payment.routes';
import jobsRoutes from './routes/jobs.routes';
import closureRoutes from './routes/closure.routes';
import auditLogRoutes from './routes/auditLog.routes';
import trashRoutes from './routes/trash.routes';
import dependentsRoutes from './routes/dependents.routes';
import archiveRoutes from './routes/archive.routes';
import anonymizeRoutes from './routes/anonymize.routes';
import roleRoutes from './routes/role.routes';
import userRoutes from './routes/user.routes';
import organizationRoutes from './routes/organization.routes';

// jobs
import { startSlotHoldSweep } from './jobs/sweepSlotHolds';
import { startEnrollmentInviteJobs } from './jobs/enrollmentInvites';
import { startTrashPurgeJob } from './jobs/trashPurge';
import { startReminderJob } from './jobs/reminders';

const app = express();
const PORT = process.env.PORT || 3001;

const allowedOrigins = (process.env.ADMIN_ORIGINS ?? 'http://localhost:3000')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Public widget endpoints are embedded on arbitrary host sites — allow any
// origin, no credentials. Per-widget origin enforcement happens in the
// `requireWidget` middleware via the widget's `allowedOrigins` allowlist.
const publicCors = cors({ origin: true, credentials: false });

// Admin / auth endpoints are locked to the admin allowlist, with credentials.
const restrictedCors = cors({ origin: allowedOrigins, credentials: true });

app.use('/api/public', publicCors);
app.use((req, res, next) => {
  if (req.path.startsWith('/api/public')) return next();
  return restrictedCors(req, res, next);
});

// Stripe webhook MUST come before express.json() so signature verification
// has the raw, unparsed body.
app.use('/api/webhooks/stripe', express.raw({ type: '*/*' }));
app.use('/api/webhooks', webhookRoutes);

app.use(express.json());

// Public auth endpoints (mounted before requireUser so they bypass the guard).
app.use('/api/auth', authRoutes);

// Public widget endpoints — no user auth, gated by publishable key + Origin check.
app.use('/api/public/widgets', publicWidgetRoutes);

// Public invite endpoints — no user auth, gated by single-use opaque token.
app.use('/api/public/invites', publicInviteRoutes);

// Public trial-reschedule endpoints — token-scoped, ≤1, ≥48h enforced.
app.use('/api/public/reschedule', publicRescheduleRoutes);

// All /api routes below require an authenticated session (dev bypass available).
// Authorization is permission-based per-route (Phase 0.3) — each router
// declares the Permission it needs via requirePermission(...).
app.use('/api', requireUser);

app.use('/api/facilitators', facilitatorRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/tags', tagRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/service-categories', serviceCategoryRoutes);
app.use('/api/scheduled-events', scheduledEventRoutes);
app.use('/api/locations', locationRoutes);
app.use('/api/context', contextRoutes);
app.use('/api/validation/scheduled-events', scheduledEventValidationRoutes);
app.use('/api/terms', termRoutes);
app.use('/api/enrollments', enrollmentRoutes);
app.use('/api/enrollments', enrollmentEngineRoutes);
app.use('/api/widgets', widgetRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/jobs', jobsRoutes);
app.use('/api/closures', closureRoutes);
app.use('/api/audit-log', auditLogRoutes);
app.use('/api/trash', trashRoutes);
app.use('/api/dependents', dependentsRoutes);
app.use('/api/archive', archiveRoutes);
app.use('/api/anonymize', anonymizeRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/users', userRoutes);
app.use('/api/organizations', organizationRoutes);

// Background jobs
startSlotHoldSweep();
startEnrollmentInviteJobs();
startTrashPurgeJob();
startReminderJob();

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

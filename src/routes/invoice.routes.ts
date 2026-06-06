import { Router } from 'express';
import { InvoiceController } from '../controllers/invoice.controller';
import { requirePermission, requireAnyPermission } from '../middleware/permission';

/**
 * Phase 1.9 — invoices. Reads admit PAYMENT_VIEW (the legacy grant invoices
 * shipped under) plus the dedicated INVOICE_VIEW_ALL / INVOICE_VIEW_SCOPED
 * permissions; the controller then narrows results to the user's facilitator
 * scope (a facilitator-linked user sees only their own invoices). Writes still
 * require PAYMENT_MANAGE. Aggregate / management reads (teacher-balances,
 * split-preview) admit full-view permissions only — not the scoped grant.
 */
const router = Router();
const controller = new InvoiceController();

// Per-invoice reads: full OR scoped view (controller applies the scope filter).
const READ_INVOICE = requireAnyPermission([
  'PAYMENT_VIEW',
  'INVOICE_VIEW_ALL',
  'INVOICE_VIEW_SCOPED',
]);
// Aggregate / management reads: full view only (no scoped facilitator grant).
const READ_INVOICE_FULL = requireAnyPermission(['PAYMENT_VIEW', 'INVOICE_VIEW_ALL']);

router.get('/', READ_INVOICE, (req, res) => controller.list(req, res));
// Phase D — per-teacher money summary. Registered before "/:id" so the
// literal segment isn't swallowed by the id param.
router.get('/teacher-balances', READ_INVOICE_FULL, (req, res) =>
  controller.teacherBalances(req, res),
);
// N.3 — per-facilitator drill-down (allocations + payouts). Literal first
// segment, so it can't be swallowed by "/:id".
router.get('/teacher-balances/:facilitatorId', READ_INVOICE_FULL, (req, res) =>
  controller.teacherBalanceDetail(req, res),
);
router.get('/:id', READ_INVOICE, (req, res) => controller.get(req, res));
// Phase D — read-only split preview.
router.get('/:id/split-preview', READ_INVOICE_FULL, (req, res) =>
  controller.splitPreview(req, res),
);
// Phase E — themeable PDF (inline by default, ?download=1 to download).
router.get('/:id/pdf', READ_INVOICE, (req, res) => controller.pdf(req, res));
router.post('/', requirePermission('PAYMENT_MANAGE'), (req, res) =>
  controller.create(req, res),
);
// Multi-biller issuance — one or more invoices (org and/or teachers) for a
// client bill, with an optional inline payment apportioned across them.
router.post('/issue', requirePermission('PAYMENT_MANAGE'), (req, res) =>
  controller.issue(req, res),
);
router.patch('/:id', requirePermission('PAYMENT_MANAGE'), (req, res) =>
  controller.update(req, res),
);
// Soft state change (DRAFT/SENT → VOID), not a hard delete — POST action.
router.post('/:id/void', requirePermission('PAYMENT_MANAGE'), (req, res) =>
  controller.void(req, res),
);
// Phase D — generate the teacher split invoices from this source invoice.
router.post('/:id/split', requirePermission('PAYMENT_MANAGE'), (req, res) =>
  controller.split(req, res),
);
// N.3 — record a reversement (payout) to a facilitator. Three literal-ish
// segments, so no collision with "/:id/..." routes.
router.post(
  '/teacher-balances/:facilitatorId/payouts',
  requirePermission('PAYMENT_MANAGE'),
  (req, res) => controller.recordPayout(req, res),
);

export default router;

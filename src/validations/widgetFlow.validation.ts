// Request validation schemas for the workflow engine API
// (Phase 2.0 Commit 3).
//
// Each schema covers one route. Public-surface schemas are stricter on
// what visitors can send. Admin-surface schemas accept the full
// FlowPayload shape (draft autosave + import).
//
// Step / field kind enums are kept in sync with the Prisma schema —
// any addition there should be mirrored here so the validator catches
// stale clients.

import { z } from 'zod';

// ─── Public-surface schemas ───────────────────────────────────────

/**
 * `POST /api/public/widget-flows/by-key/:publishableKey/runs`
 *
 * Body is empty in v1 — a fresh run starts with empty vars and uses
 * the flow's first step. Future commits may accept seed vars (e.g.
 * referral source) here.
 */
export const startRunBodySchema = z.object({}).passthrough();

/**
 * `POST /api/public/widget-flows/by-key/:publishableKey/runs/:runId/steps/:stepId/submit`
 *
 * The `values` object is per-step-kind and validated server-side by
 * the handler (see services/engine/stepHandlers/). We only enforce
 * the wrapper shape here.
 */
export const submitStepBodySchema = z.object({
  values: z.record(z.string(), z.unknown()).default({}),
  // clientSubmitId MUST be a v4 UUID (the engine treats it as opaque
  // but enforcing format here catches buggy clients early).
  clientSubmitId: z.string().uuid({
    message: 'clientSubmitId must be a UUID v4',
  }),
});

// ─── Admin-surface schemas ────────────────────────────────────────

const widgetStepKindEnum = z.enum([
  'SINGLE_SELECT',
  'MULTI_SELECT',
  'RADIO',
  'CHECKBOX',
  'TEXT_INPUT',
  'TEXTAREA',
  'NUMBER',
  'EMAIL',
  'PHONE',
  'DATE_PICKER',
  'TIME_PICKER',
  'SLOT_PICKER',
  'FORM',
  'TEXT_BLOCK',
  'RECAP',
  'STRIPE_CHECKOUT',
  'VALIDATION',
]);

const widgetFieldKindEnum = z.enum([
  'TEXT',
  'TEXTAREA',
  'EMAIL',
  'PHONE',
  'NUMBER',
  'DATE',
  'BOOLEAN',
  'SELECT',
  'MULTI_SELECT',
]);

const widgetFieldBindingEnum = z.enum(['VAR', 'DB_COLUMN', 'CUSTOM_FIELD']);

const widgetFlowKindEnum = z.enum(['BOOKING', 'EVENT_REACTION']);

/**
 * JSON-serializable value. Used for step/field config bodies which are
 * arbitrary user-shaped data (option lists, regex hints, etc.).
 */
const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

// One field inside a FORM step.
const flowFieldSchema = z.object({
  order: z.number().int().min(0),
  kind: widgetFieldKindEnum,
  label: z.string().min(1),
  placeholder: z.string().nullable().optional(),
  required: z.boolean().default(false),
  binding: widgetFieldBindingEnum,
  bindingTarget: z.string().min(1),
  config: z.record(z.string(), jsonValueSchema).default({}),
});

// One step inside a flow.
const flowStepSchema = z.object({
  order: z.number().int().min(0),
  kind: widgetStepKindEnum,
  label: z.string().min(1),
  description: z.string().nullable().optional(),
  config: z.record(z.string(), jsonValueSchema).default({}),
  // JSONLogic-shaped expression; stored as opaque JSON for v1.
  visibleWhen: jsonValueSchema.nullable().optional(),
  fields: z.array(flowFieldSchema).default([]),
});

// Phase 2.2 — actions live in the payload too, alongside steps. This
// keeps them snapshotted on Publish, round-trippable through export/
// import, and atomic-replaced by writePayloadToFlow. Action kinds
// stay as plain strings here (the action handler registry is the
// authoritative whitelist; new kinds add without schema churn).
//
// The recursive `children` field is the tree for CONDITIONAL actions
// (and any future composite kind). z.lazy() handles the self-reference;
// z.array(flowActionSchema) inside the lazy means the schema validates
// arbitrarily deep nesting (capped at the engine's runtime depth, not
// here).
type FlowActionPayload = {
  order: number;
  kind: string;
  config: Record<string, unknown>;
  children?: FlowActionPayload[];
};
const flowActionSchema: z.ZodType<FlowActionPayload> = z.lazy(() =>
  z.object({
    order: z.number().int().min(0),
    kind: z.string().min(1),
    config: z.record(z.string(), jsonValueSchema).default({}),
    children: z.array(flowActionSchema).default([]),
  }),
);

// Phase 2.3 — event-bus triggers. Only meaningful for EVENT_REACTION
// flows; BOOKING flows ignore them (the visitor's submit drives them
// instead). Stored on the payload so they snapshot + round-trip with
// the rest of the flow definition.
const flowTriggerSchema = z.object({
  eventName: z.string().min(1),
  // Optional JSONLogic gate evaluated against `event.<X>` payload.
  // Null/missing = "fire on every event of this name".
  filter: jsonValueSchema.nullable().optional(),
});

/**
 * Canonical flow payload shape. Used by:
 *   - WidgetFlowDraft.payload   (autosave target)
 *   - WidgetFlowSnapshot.payload (immutable per-Publish copy)
 *   - export JSON                (admin download)
 *   - import JSON                (admin upload)
 *
 * Deliberately excludes id / publishableKey / version / isPublished /
 * timestamps — those are system-managed and would defeat the
 * "round-trippable" property if encoded into the payload.
 */
export const flowPayloadSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  kind: widgetFlowKindEnum,
  steps: z.array(flowStepSchema),
  // Phase 2.2 — optional for backward compat with pre-2.2 drafts that
  // were saved before this field existed. Empty array (= no actions)
  // is the safe default.
  actions: z.array(flowActionSchema).default([]),
  // Phase 2.3 — same back-compat treatment. Most flows have no
  // triggers (BOOKING flows ignore them entirely).
  triggers: z.array(flowTriggerSchema).default([]),
});

export type FlowPayload = z.infer<typeof flowPayloadSchema>;

/**
 * `POST /api/widget-flows` — create a fresh flow.
 *
 * Name + kind are required; everything else is optional (the admin
 * starts with an empty draft they fill in via the editor).
 */
export const createFlowBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  kind: widgetFlowKindEnum.default('BOOKING'),
});

/**
 * `PATCH /api/widget-flows/:id/draft` — autosave target.
 *
 * Accepts the full FlowPayload. The admin's editor sends the whole
 * working copy on each debounced save (we never query INTO the draft
 * — single JSON blob, no normalization while editing).
 */
export const patchDraftBodySchema = flowPayloadSchema;

/**
 * `POST /api/widget-flows/import` — upload a previously-exported flow
 * JSON. The schema matches `flowPayloadSchema` exactly; import always
 * creates a NEW flow with a fresh id + cleared publishableKey.
 */
export const importFlowBodySchema = flowPayloadSchema;

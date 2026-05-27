// Request validation schemas for the workflow engine API
// (Phase 3.1 — graph engine v2).
//
// REPLACED in Phase 3.1: the v1 shape (steps + actions + triggers as
// separate arrays) was unified into a single nodes + edges graph.
// Entry points (visitor URL / event / cron) became first-class
// descriptors that reference an entry node.
//
// Step / action / trigger / wait kind values are kept as plain
// strings (not Zod enums) so adding a new node kind is purely
// app-layer work — the handler registry is the authoritative
// whitelist.

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
 * `POST /api/public/widget-flows/by-key/:publishableKey/runs/:runId/nodes/:nodeId/submit`
 *
 * The `values` object is per-node-kind and validated server-side by
 * the handler. We only enforce the wrapper shape here.
 */
export const submitNodeBodySchema = z.object({
  values: z.record(z.string(), z.unknown()).default({}),
  // clientSubmitId MUST be a v4 UUID (the engine treats it as opaque
  // but enforcing format here catches buggy clients early).
  clientSubmitId: z.string().uuid({
    message: 'clientSubmitId must be a UUID v4',
  }),
});

// ─── Admin-surface schemas ────────────────────────────────────────

const widgetFlowKindEnum = z.enum(['BOOKING', 'EVENT_REACTION']);

/**
 * JSON-serializable value. Used for node/edge/entrypoint config
 * payloads which are arbitrary user-shaped data (option lists,
 * JSONLogic expressions, etc.).
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

// ─── Graph payload (v2) ───────────────────────────────────────────

/**
 * One node in the flow graph. `id` is the stable identifier the
 * canvas editor invents (crypto.randomUUID()) and survives across
 * autosaves + publish round-trips — same id at every layer.
 *
 * `kind` is a plain string from the node-handler registry. v2 ships:
 *   UI:     SINGLE_SELECT | MULTI_SELECT | FORM | TEXT_BLOCK | RECAP
 *   ACTION: SEND_EMAIL | (future: ISSUE_REFUND | UPDATE_ENTITY | …)
 *   WAIT:   WAIT_DURATION | WAIT_UNTIL | WAIT_TOKEN
 *
 * `config` is kind-specific (validated by the node handler at publish
 * time via validateConfig + at runtime via the handler's own checks).
 */
const flowNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  label: z.string(), // can be empty during draft editing
  description: z.string().nullable().optional(),
  config: z.record(z.string(), jsonValueSchema).default({}),
  position: z
    .object({
      x: z.number(),
      y: z.number(),
    })
    .default({ x: 0, y: 0 }),
});

/**
 * Directed edge between two nodes. Multiple outgoing edges from one
 * node form a branch — the engine picks the first whose `condition`
 * evaluates truthy in `order`. A null condition always matches
 * (useful as a catch-all last edge).
 */
const flowEdgeSchema = z.object({
  fromNodeId: z.string().min(1),
  toNodeId: z.string().min(1),
  order: z.number().int().min(0).default(0),
  condition: jsonValueSchema.nullable().optional(),
  label: z.string().nullable().optional(),
});

/**
 * Entry point descriptor — replaces the v1 WidgetTrigger model.
 * Tells the engine WHERE a run starts (entryNodeId) and HOW it's
 * triggered (kind: visitor | event | cron). Multiple per flow if
 * the same flow handles e.g. both a visitor URL and a bus event.
 */
const flowEntryPointSchema = z.object({
  kind: z.enum(['visitor', 'event', 'cron']),
  /**
   * Kind-specific config:
   *   visitor: {}                        — the flow's publishableKey IS the URL
   *   event:   { eventName, filter? }    — bus event name + optional JSONLogic
   *   cron:    { schedule }              — cron expression (Phase 3.2+)
   */
  config: z.record(z.string(), jsonValueSchema).default({}),
  entryNodeId: z.string().nullable(),
});

/**
 * Canonical flow payload shape (v2). Used by:
 *   - WidgetFlowDraft.payload   (autosave target)
 *   - WidgetFlowSnapshot.payload (immutable per-Publish copy)
 *   - export JSON                (admin download)
 *   - import JSON                (admin upload)
 *
 * Excludes system-managed fields: id / publishableKey / version /
 * isPublished / timestamps / soft-delete + archive stamps.
 */
export const flowPayloadSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  kind: widgetFlowKindEnum,
  nodes: z.array(flowNodeSchema).default([]),
  edges: z.array(flowEdgeSchema).default([]),
  entryPoints: z.array(flowEntryPointSchema).default([]),
});

export type FlowPayload = z.infer<typeof flowPayloadSchema>;
export type FlowNodePayload = z.infer<typeof flowNodeSchema>;
export type FlowEdgePayload = z.infer<typeof flowEdgeSchema>;
export type FlowEntryPointPayload = z.infer<typeof flowEntryPointSchema>;

/**
 * `POST /api/widget-flows` — create a fresh flow.
 *
 * Name + kind are required; everything else is optional (the admin
 * starts with an empty graph they fill in via the canvas editor).
 */
export const createFlowBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  kind: widgetFlowKindEnum.default('BOOKING'),
});

/**
 * `PATCH /api/widget-flows/:id/draft` — autosave target.
 *
 * Accepts the full FlowPayload. The admin's canvas editor sends the
 * whole working copy on each debounced save (we never query INTO the
 * draft; single JSON blob, no normalization while editing).
 */
export const patchDraftBodySchema = flowPayloadSchema;

/**
 * `POST /api/widget-flows/import` — upload a previously-exported flow
 * JSON. The schema matches `flowPayloadSchema` exactly; import always
 * creates a NEW flow with a fresh id + cleared publishableKey.
 */
export const importFlowBodySchema = flowPayloadSchema;

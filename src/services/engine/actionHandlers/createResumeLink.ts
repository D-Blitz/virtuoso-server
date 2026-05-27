// CREATE_RESUME_LINK action handler (Phase 3.2b).
//
// Generates a single-use WidgetResumeToken for the current run +
// writes the resume URL into a configurable var (default
// `vars.resumeUrl`). Paired with a downstream WAIT_TOKEN node:
//
//   [entry] → CREATE_RESUME_LINK → SEND_EMAIL ({vars.resumeUrl}) → WAIT_TOKEN → [next]
//
// SEND_EMAIL interpolates the URL into its body. WAIT_TOKEN pauses
// until the URL is clicked. Clicking calls
// /api/public/widget-flows/resume/:tokenId which consumes the token +
// advances the run past WAIT_TOKEN.
//
// Why a separate action node instead of bundling into WAIT_TOKEN:
// SEND_EMAIL needs the URL in vars BEFORE the run pauses. WAIT_TOKEN
// suspends as soon as it executes, so generating the URL there
// leaves SEND_EMAIL with nothing to interpolate. Splitting into two
// nodes lets the admin author "create link → send email → wait" in
// natural reading order.
//
// Config shape:
//   {
//     "urlVar":         "resumeUrl",     // var name (default: "resumeUrl")
//     "tokenVar":       "resumeToken",   // var name (default: "resumeToken")
//     "expirationDays": 30,              // default 30, max 365
//     "publicBaseUrl":  "https://…"      // optional override; otherwise
//                                         //   PUBLIC_ADMIN_URL env or fallback
//   }

import prisma from '../../../prisma';
import type { ActionHandler, ActionResult } from './types';

type CreateResumeLinkConfig = {
  urlVar?: string;
  tokenVar?: string;
  expirationDays?: number;
  publicBaseUrl?: string;
};

const DEFAULT_URL_VAR = 'resumeUrl';
const DEFAULT_TOKEN_VAR = 'resumeToken';
const DEFAULT_EXPIRATION_DAYS = 30;
const MAX_EXPIRATION_DAYS = 365;

function defaultBaseUrl(): string {
  // Prefer the admin public URL (where the resume route lives).
  // Falls back to localhost:3000 for dev.
  return (
    process.env.PUBLIC_ADMIN_URL ??
    process.env.ADMIN_ORIGINS?.split(',')[0]?.trim() ??
    'http://localhost:3000'
  );
}

export const createResumeLinkHandler: ActionHandler = {
  kind: 'CREATE_RESUME_LINK',

  validateConfig(config) {
    if (config && typeof config !== 'object') {
      return 'CREATE_RESUME_LINK config must be an object (or empty)';
    }
    const c = (config ?? {}) as Record<string, unknown>;
    if (c.urlVar !== undefined && typeof c.urlVar !== 'string') {
      return 'CREATE_RESUME_LINK config.urlVar must be a string';
    }
    if (c.tokenVar !== undefined && typeof c.tokenVar !== 'string') {
      return 'CREATE_RESUME_LINK config.tokenVar must be a string';
    }
    if (
      c.expirationDays !== undefined &&
      (typeof c.expirationDays !== 'number' ||
        c.expirationDays <= 0 ||
        c.expirationDays > MAX_EXPIRATION_DAYS)
    ) {
      return `CREATE_RESUME_LINK config.expirationDays must be a positive number up to ${MAX_EXPIRATION_DAYS}`;
    }
    if (c.publicBaseUrl !== undefined && typeof c.publicBaseUrl !== 'string') {
      return 'CREATE_RESUME_LINK config.publicBaseUrl must be a string URL';
    }
    return null;
  },

  async execute(action, context): Promise<ActionResult> {
    const cfg = (action.config ?? {}) as CreateResumeLinkConfig;
    const urlVar = cfg.urlVar ?? DEFAULT_URL_VAR;
    const tokenVar = cfg.tokenVar ?? DEFAULT_TOKEN_VAR;
    const expirationDays = cfg.expirationDays ?? DEFAULT_EXPIRATION_DAYS;
    const baseUrl = cfg.publicBaseUrl ?? defaultBaseUrl();

    if (!context.runId) {
      return {
        status: 'ERROR',
        message: 'CREATE_RESUME_LINK requires a runId (no fire-and-forget mode)',
      };
    }

    const expiresAt = new Date(
      Date.now() + expirationDays * 24 * 60 * 60 * 1000,
    );

    // Token nodeId references the ACTION node itself — the resume
    // route validates token.runId.currentNodeId is a WAIT_TOKEN at
    // consume time, not at create time, so any nodeId is fine here.
    // Using action.id keeps the linkage traceable in metering.
    const token = await prisma.widgetResumeToken.create({
      data: {
        flowId: action.flowId,
        runId: context.runId,
        nodeId: action.id,
        expiresAt,
      },
    });

    const url = `${baseUrl.replace(/\/$/, '')}/widget-flow/resume/${token.id}`;

    // Mutate the live evaluation context's vars in place so the next
    // ACTION node in the same walk (typically SEND_EMAIL) sees the
    // freshly-written values without an extra DB round-trip. The
    // runtime persists context.evaluationContext.vars back to
    // run.vars at the end of the walk via the regular vars path —
    // but ACTION nodes don't write vars in v2 (see graphRuntime).
    //
    // Workaround: write the vars directly via prisma so they persist
    // for downstream nodes in the SAME run (not just this walk).
    // This is a small "side effect" — formalize as an "action vars
    // patch" feature in a later phase.
    const ctxVars = context.evaluationContext.vars as Record<string, unknown>;
    ctxVars[urlVar] = url;
    ctxVars[tokenVar] = token.id;

    await prisma.widgetRun.update({
      where: { id: context.runId },
      data: { vars: ctxVars as unknown as object },
    });

    return { status: 'OK' };
  },
};

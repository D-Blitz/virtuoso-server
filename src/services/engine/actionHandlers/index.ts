// Action handler registry (Phase 2.2).
//
// Maps action kind strings to their handlers. Adding a new kind is
// purely additive — register it here and the executor picks it up.
//
// Phase 2.2 ships: SEND_EMAIL, CONDITIONAL
// Phase 2.2 stubs: WAIT (no-op; real impl needs a queue / scheduler)
// Phase 2.5+:      ISSUE_REFUND, UPDATE_ENTITY, CREATE_SCHEDULED_EVENT

import { sendEmailHandler } from './sendEmail';
import { conditionalHandler } from './conditional';
import type { ActionHandler, ActionResult } from './types';

/**
 * WAIT — placeholder. Returns OK immediately. A real implementation
 * would enqueue a delayed action (e.g. via a row-based delay queue
 * with a sweeper job). Listed here so admins can drop WAIT into a
 * tree today without breaking the executor; once the queue lands,
 * existing flows pick up the new behavior automatically.
 */
const waitHandler: ActionHandler = {
  kind: 'WAIT',
  validateConfig() {
    return null;
  },
  async execute(): Promise<ActionResult> {
    return { status: 'OK' };
  },
};

export const actionHandlers: Record<string, ActionHandler> = {
  SEND_EMAIL: sendEmailHandler,
  CONDITIONAL: conditionalHandler,
  WAIT: waitHandler,
};

export function getActionHandler(kind: string): ActionHandler | null {
  return actionHandlers[kind] ?? null;
}

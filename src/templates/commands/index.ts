/**
 * @module templates/commands
 * @description FlowGuard command templates — one file per command.
 *
 * Barrel file that assembles all individual command templates
 * into the COMMANDS registry used by install and runtime.
 *
 * @version v1
 */

import { HYDRATE_COMMAND } from './hydrate.js';
import { STATUS_COMMAND } from './status.js';
import { TICKET_COMMAND } from './ticket.js';
import { PLAN_COMMAND } from './plan.js';
import { CONTINUE_COMMAND } from './continue.js';
import { IMPLEMENT_COMMAND } from './implement.js';
import { VALIDATE_COMMAND } from './validate.js';
import { REVIEW_DECISION_COMMAND } from './review-decision.js';
import { REVIEW_COMMAND } from './review.js';
import { ARCHITECTURE_COMMAND } from './architecture.js';
import { ABORT_COMMAND } from './abort.js';
import { ARCHIVE_COMMAND } from './archive.js';

export const COMMANDS: Record<string, string> = {
  'hydrate.md': HYDRATE_COMMAND,
  'status.md': STATUS_COMMAND,
  'ticket.md': TICKET_COMMAND,
  'plan.md': PLAN_COMMAND,
  'continue.md': CONTINUE_COMMAND,
  'implement.md': IMPLEMENT_COMMAND,
  'validate.md': VALIDATE_COMMAND,
  'review-decision.md': REVIEW_DECISION_COMMAND,
  'review.md': REVIEW_COMMAND,
  'architecture.md': ARCHITECTURE_COMMAND,
  'abort.md': ABORT_COMMAND,
  'archive.md': ARCHIVE_COMMAND,
};

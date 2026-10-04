/**
 * @module templates/commands
 * @description FlowGuard command templates — one file per command.
 *
 * Barrel file that assembles all individual command templates
 * into the COMMANDS registry used by install and runtime.
 *
 * All templates use positive language per Anthropic and OpenAI
 * prompt engineering best practices. Shared governance rules are rendered
 * directly from the mandates authority.
 *
 * @version v3
 */

import { HYDRATE_COMMAND } from './hydrate.js';
import { STATUS_COMMAND } from './status.js';
import { TICKET_COMMAND } from './ticket.js';
import { PLAN_COMMAND } from './plan.js';
import { CONTINUE_COMMAND } from './continue.js';
import { IMPLEMENT_COMMAND } from './implement.js';
import { RESOLVE_IMPLEMENTATION_CHALLENGE_COMMAND } from './resolve-implementation-challenge.js';
import { RECONCILE_MUTATION_EPISODE_COMMAND } from './reconcile-mutation-episode.js';
import { VALIDATE_COMMAND } from './validate.js';
import { REVIEW_DECISION_COMMAND } from './review-decision.js';
import { REVIEW_COMMAND } from './review.js';
import { ARCHITECTURE_COMMAND } from './architecture.js';
import { ABORT_COMMAND } from './abort.js';
import { ARCHIVE_COMMAND } from './archive.js';
import { START_COMMAND } from './start.js';
import { TASK_COMMAND } from './task.js';
import { APPROVE_COMMAND } from './approve.js';
import { OVERRIDE_APPROVE_COMMAND } from './override-approve.js';
import { REQUEST_CHANGES_COMMAND } from './request-changes.js';
import { REJECT_COMMAND } from './reject.js';
import { CHECK_COMMAND } from './check.js';
import { EXPORT_COMMAND } from './export.js';
import { WHY_COMMAND } from './why.js';
import { FINISH_COMMAND } from './finish.js';
import { HELP_COMMAND } from './help.js';
import { COMMANDS_COMMAND } from './commands.js';

const COMMAND_BODIES: Record<string, string> = {
  'hydrate.md': HYDRATE_COMMAND,
  'status.md': STATUS_COMMAND,
  'ticket.md': TICKET_COMMAND,
  'plan.md': PLAN_COMMAND,
  'continue.md': CONTINUE_COMMAND,
  'implement.md': IMPLEMENT_COMMAND,
  'resolve-implementation-challenge.md': RESOLVE_IMPLEMENTATION_CHALLENGE_COMMAND,
  'reconcile-mutation-episode.md': RECONCILE_MUTATION_EPISODE_COMMAND,
  'validate.md': VALIDATE_COMMAND,
  'review-decision.md': REVIEW_DECISION_COMMAND,
  'review.md': REVIEW_COMMAND,
  'architecture.md': ARCHITECTURE_COMMAND,
  'abort.md': ABORT_COMMAND,
  'archive.md': ARCHIVE_COMMAND,
  'start.md': START_COMMAND,
  'task.md': TASK_COMMAND,
  'approve.md': APPROVE_COMMAND,
  'override-approve.md': OVERRIDE_APPROVE_COMMAND,
  'request-changes.md': REQUEST_CHANGES_COMMAND,
  'reject.md': REJECT_COMMAND,
  'check.md': CHECK_COMMAND,
  'export.md': EXPORT_COMMAND,
  'why.md': WHY_COMMAND,
  'finish.md': FINISH_COMMAND,
  'help.md': HELP_COMMAND,
  'commands.md': COMMANDS_COMMAND,
};

/**
 * Installer-compatible projection of the command template bodies.
 *
 * The template-file set is owned by this layer: the catalogue in
 * `integration/installed-commands.ts` must reference exactly these files, and
 * `integration/installed-commands.test.ts` enforces that bidirectionally. The
 * templates layer never imports the catalogue.
 */
export const COMMANDS: Record<string, string> = { ...COMMAND_BODIES };

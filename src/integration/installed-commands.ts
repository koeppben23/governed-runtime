/**
 * @module integration/installed-commands
 * @description Canonical metadata for installed FlowGuard slash-command interfaces.
 *
 * This is an interface catalogue, not a workflow authority. Machine lifecycle
 * admissibility remains in machine/commands.ts; aliases remain in
 * command-aliases.ts. Command templates consume this catalogue when assembled so
 * an installed template cannot silently drift from its public interface.
 */

import { Command } from '../machine/commands.js';
import { COMMAND_ALIASES } from './command-aliases.js';
import {
  TOOL_FLOWGUARD_ABORT,
  TOOL_FLOWGUARD_ARCHITECTURE,
  TOOL_FLOWGUARD_ARCHIVE,
  TOOL_FLOWGUARD_CONTINUE,
  TOOL_FLOWGUARD_DECISION,
  TOOL_FLOWGUARD_HELP,
  TOOL_FLOWGUARD_HYDRATE,
  TOOL_FLOWGUARD_IMPLEMENT,
  TOOL_FLOWGUARD_PLAN,
  TOOL_FLOWGUARD_REVIEW,
  TOOL_FLOWGUARD_RUN_CHECK,
  TOOL_FLOWGUARD_STATUS,
  TOOL_FLOWGUARD_TICKET,
} from './tool-names.js';

export type PresentationGroup =
  'start' | 'work' | 'review' | 'verify' | 'complete' | 'export' | 'recovery' | 'information';

export type InstalledCommandId =
  | 'workflow.hydrate'
  | 'operational.status'
  | 'workflow.ticket'
  | 'workflow.plan'
  | 'workflow.continue'
  | 'workflow.implement'
  | 'workflow.validate'
  | 'workflow.review-decision'
  | 'workflow.review'
  | 'workflow.architecture'
  | 'workflow.abort'
  | 'operational.archive'
  | 'alias.start'
  | 'alias.task'
  | 'variant.approve'
  | 'variant.request-changes'
  | 'variant.reject'
  | 'alias.check'
  | 'alias.export'
  | 'alias.why'
  | 'operational.finish'
  | 'operational.help.context'
  | 'operational.help.commands';

type ToolName =
  | typeof TOOL_FLOWGUARD_ABORT
  | typeof TOOL_FLOWGUARD_ARCHITECTURE
  | typeof TOOL_FLOWGUARD_ARCHIVE
  | typeof TOOL_FLOWGUARD_CONTINUE
  | typeof TOOL_FLOWGUARD_DECISION
  | typeof TOOL_FLOWGUARD_HELP
  | typeof TOOL_FLOWGUARD_HYDRATE
  | typeof TOOL_FLOWGUARD_IMPLEMENT
  | typeof TOOL_FLOWGUARD_PLAN
  | typeof TOOL_FLOWGUARD_REVIEW
  | typeof TOOL_FLOWGUARD_RUN_CHECK
  | typeof TOOL_FLOWGUARD_STATUS
  | typeof TOOL_FLOWGUARD_TICKET;

export interface InstalledCommandDefinition {
  readonly id: InstalledCommandId;
  readonly filename: `${string}.md`;
  readonly invocation: `/${string}`;
  readonly kind: 'workflow' | 'operational' | 'preferred_name' | 'action_variant' | 'convenience';
  readonly target: Readonly<{
    toolName: ToolName;
    fixedArgs?: Readonly<Record<string, unknown>>;
    workflowCommand?: Command;
  }>;
  readonly visibility: 'primary' | 'visible_alias' | 'compatibility';
  readonly presentationGroup: PresentationGroup;
}

function aliasKind(alias: keyof typeof COMMAND_ALIASES): InstalledCommandDefinition['kind'] {
  return COMMAND_ALIASES[alias]!.kind;
}

/** Every installed template has exactly one stable public-interface identity. */
export const INSTALLED_COMMANDS: readonly InstalledCommandDefinition[] = [
  {
    id: 'workflow.hydrate',
    filename: 'hydrate.md',
    invocation: '/hydrate',
    kind: 'workflow',
    target: { toolName: TOOL_FLOWGUARD_HYDRATE, workflowCommand: Command.HYDRATE },
    visibility: 'primary',
    presentationGroup: 'start',
  },
  {
    id: 'operational.status',
    filename: 'status.md',
    invocation: '/status',
    kind: 'operational',
    target: { toolName: TOOL_FLOWGUARD_STATUS },
    visibility: 'primary',
    presentationGroup: 'information',
  },
  {
    id: 'workflow.ticket',
    filename: 'ticket.md',
    invocation: '/ticket',
    kind: 'workflow',
    target: { toolName: TOOL_FLOWGUARD_TICKET, workflowCommand: Command.TICKET },
    visibility: 'compatibility',
    presentationGroup: 'start',
  },
  {
    id: 'workflow.plan',
    filename: 'plan.md',
    invocation: '/plan',
    kind: 'workflow',
    target: { toolName: TOOL_FLOWGUARD_PLAN, workflowCommand: Command.PLAN },
    visibility: 'primary',
    presentationGroup: 'work',
  },
  {
    id: 'workflow.continue',
    filename: 'continue.md',
    invocation: '/continue',
    kind: 'workflow',
    target: { toolName: TOOL_FLOWGUARD_CONTINUE, workflowCommand: Command.CONTINUE },
    visibility: 'primary',
    presentationGroup: 'work',
  },
  {
    id: 'workflow.implement',
    filename: 'implement.md',
    invocation: '/implement',
    kind: 'workflow',
    target: { toolName: TOOL_FLOWGUARD_IMPLEMENT, workflowCommand: Command.IMPLEMENT },
    visibility: 'primary',
    presentationGroup: 'work',
  },
  {
    id: 'workflow.validate',
    filename: 'validate.md',
    invocation: '/validate',
    kind: 'workflow',
    target: { toolName: TOOL_FLOWGUARD_RUN_CHECK, workflowCommand: Command.VALIDATE },
    visibility: 'compatibility',
    presentationGroup: 'verify',
  },
  {
    id: 'workflow.review-decision',
    filename: 'review-decision.md',
    invocation: '/review-decision',
    kind: 'workflow',
    target: { toolName: TOOL_FLOWGUARD_DECISION, workflowCommand: Command.REVIEW_DECISION },
    visibility: 'compatibility',
    presentationGroup: 'review',
  },
  {
    id: 'workflow.review',
    filename: 'review.md',
    invocation: '/review',
    kind: 'workflow',
    target: { toolName: TOOL_FLOWGUARD_REVIEW, workflowCommand: Command.REVIEW },
    visibility: 'primary',
    presentationGroup: 'review',
  },
  {
    id: 'workflow.architecture',
    filename: 'architecture.md',
    invocation: '/architecture',
    kind: 'workflow',
    target: { toolName: TOOL_FLOWGUARD_ARCHITECTURE, workflowCommand: Command.ARCHITECTURE },
    visibility: 'primary',
    presentationGroup: 'review',
  },
  {
    id: 'workflow.abort',
    filename: 'abort.md',
    invocation: '/abort',
    kind: 'workflow',
    target: { toolName: TOOL_FLOWGUARD_ABORT, workflowCommand: Command.ABORT },
    visibility: 'primary',
    presentationGroup: 'recovery',
  },
  {
    id: 'operational.archive',
    filename: 'archive.md',
    invocation: '/archive',
    kind: 'operational',
    target: { toolName: TOOL_FLOWGUARD_ARCHIVE },
    visibility: 'visible_alias',
    presentationGroup: 'export',
  },
  {
    id: 'alias.start',
    filename: 'start.md',
    invocation: '/start',
    kind: aliasKind('start'),
    target: { toolName: TOOL_FLOWGUARD_HYDRATE, workflowCommand: Command.HYDRATE },
    visibility: 'primary',
    presentationGroup: 'start',
  },
  {
    id: 'alias.task',
    filename: 'task.md',
    invocation: '/task',
    kind: aliasKind('task'),
    target: { toolName: TOOL_FLOWGUARD_TICKET, workflowCommand: Command.TICKET },
    visibility: 'primary',
    presentationGroup: 'start',
  },
  {
    id: 'variant.approve',
    filename: 'approve.md',
    invocation: '/approve',
    kind: aliasKind('approve'),
    target: {
      toolName: TOOL_FLOWGUARD_DECISION,
      fixedArgs: COMMAND_ALIASES.approve!.defaultArgs,
      workflowCommand: Command.REVIEW_DECISION,
    },
    visibility: 'primary',
    presentationGroup: 'review',
  },
  {
    id: 'variant.request-changes',
    filename: 'request-changes.md',
    invocation: '/request-changes',
    kind: aliasKind('request-changes'),
    target: {
      toolName: TOOL_FLOWGUARD_DECISION,
      fixedArgs: COMMAND_ALIASES['request-changes']!.defaultArgs,
      workflowCommand: Command.REVIEW_DECISION,
    },
    visibility: 'primary',
    presentationGroup: 'review',
  },
  {
    id: 'variant.reject',
    filename: 'reject.md',
    invocation: '/reject',
    kind: aliasKind('reject'),
    target: {
      toolName: TOOL_FLOWGUARD_DECISION,
      fixedArgs: COMMAND_ALIASES.reject!.defaultArgs,
      workflowCommand: Command.REVIEW_DECISION,
    },
    visibility: 'primary',
    presentationGroup: 'review',
  },
  {
    id: 'alias.check',
    filename: 'check.md',
    invocation: '/check',
    kind: aliasKind('check'),
    target: { toolName: TOOL_FLOWGUARD_RUN_CHECK, workflowCommand: Command.VALIDATE },
    visibility: 'primary',
    presentationGroup: 'verify',
  },
  {
    id: 'alias.export',
    filename: 'export.md',
    invocation: '/export',
    kind: aliasKind('export'),
    target: { toolName: TOOL_FLOWGUARD_ARCHIVE },
    visibility: 'primary',
    presentationGroup: 'export',
  },
  {
    id: 'alias.why',
    filename: 'why.md',
    invocation: '/why',
    kind: aliasKind('why'),
    target: { toolName: TOOL_FLOWGUARD_STATUS, fixedArgs: COMMAND_ALIASES.why!.defaultArgs },
    visibility: 'primary',
    presentationGroup: 'information',
  },
  {
    id: 'operational.finish',
    filename: 'finish.md',
    invocation: '/finish',
    kind: 'operational',
    target: { toolName: TOOL_FLOWGUARD_STATUS, fixedArgs: { finish: true } },
    visibility: 'primary',
    presentationGroup: 'complete',
  },
  {
    id: 'operational.help.context',
    filename: 'help.md',
    invocation: '/help',
    kind: 'operational',
    target: { toolName: TOOL_FLOWGUARD_HELP, fixedArgs: { view: 'context' } },
    visibility: 'primary',
    presentationGroup: 'information',
  },
  {
    id: 'operational.help.commands',
    filename: 'commands.md',
    invocation: '/commands',
    kind: 'operational',
    target: { toolName: TOOL_FLOWGUARD_HELP, fixedArgs: { view: 'commands', scope: 'available' } },
    visibility: 'primary',
    presentationGroup: 'information',
  },
];

export function getInstalledCommand(invocation: string): InstalledCommandDefinition | undefined {
  return INSTALLED_COMMANDS.find((definition) => definition.invocation === invocation);
}

export function preferredInvocationForTool(toolName: ToolName): string | undefined {
  return INSTALLED_COMMANDS.find(
    (definition) => definition.target.toolName === toolName && definition.visibility === 'primary',
  )?.invocation;
}

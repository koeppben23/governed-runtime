/**
 * @module integration/installed-commands
 * @description Canonical metadata for installed FlowGuard slash-command interfaces.
 *
 * This is an interface catalogue, not a workflow authority. Machine lifecycle
 * admissibility remains in machine/commands.ts; aliases remain in
 * command-aliases.ts. Command templates consume this catalogue when assembled so
 * an installed template cannot silently drift from its public interface.
 *
 * Multiple interface identities may share a single template file.
 */

import { Command } from '../machine/commands.js';
import { COMMAND_ALIASES } from './command-aliases.js';
import {
  TOOL_FLOWGUARD_ABORT,
  TOOL_FLOWGUARD_ARCHITECTURE,
  TOOL_FLOWGUARD_ARCHIVE,
  TOOL_FLOWGUARD_CONTINUE,
  TOOL_FLOWGUARD_DECISION,
  TOOL_FLOWGUARD_EXTEND_IMPLEMENTATION_REVIEW,
  TOOL_FLOWGUARD_HELP,
  TOOL_FLOWGUARD_HYDRATE,
  TOOL_FLOWGUARD_IMPLEMENT,
  TOOL_FLOWGUARD_PLAN,
  TOOL_FLOWGUARD_RECONCILE_MUTATION_EPISODE,
  TOOL_FLOWGUARD_REVIEW,
  TOOL_FLOWGUARD_RESOLVE_IMPLEMENTATION_CHALLENGE,
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
  | 'workflow.extend-implementation-review'
  | 'workflow.resolve-implementation-challenge'
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
  | 'operational.reconcile-mutation-episode'
  | 'operational.help.context'
  | 'operational.help.commands'
  | 'operational.help.commands-all';

type ToolName =
  | typeof TOOL_FLOWGUARD_ABORT
  | typeof TOOL_FLOWGUARD_ARCHITECTURE
  | typeof TOOL_FLOWGUARD_ARCHIVE
  | typeof TOOL_FLOWGUARD_CONTINUE
  | typeof TOOL_FLOWGUARD_DECISION
  | typeof TOOL_FLOWGUARD_EXTEND_IMPLEMENTATION_REVIEW
  | typeof TOOL_FLOWGUARD_HELP
  | typeof TOOL_FLOWGUARD_HYDRATE
  | typeof TOOL_FLOWGUARD_IMPLEMENT
  | typeof TOOL_FLOWGUARD_PLAN
  | typeof TOOL_FLOWGUARD_REVIEW
  | typeof TOOL_FLOWGUARD_RECONCILE_MUTATION_EPISODE
  | typeof TOOL_FLOWGUARD_RESOLVE_IMPLEMENTATION_CHALLENGE
  | typeof TOOL_FLOWGUARD_RUN_CHECK
  | typeof TOOL_FLOWGUARD_STATUS
  | typeof TOOL_FLOWGUARD_TICKET;

export interface InstalledCommandDefinition {
  readonly id: InstalledCommandId;
  /** Template body file to install. Multiple definitions may share a file. */
  readonly templateFile: `${string}.md`;
  readonly invocation: `/${string}`;
  readonly kind: 'workflow' | 'operational' | 'preferred_name' | 'action_variant' | 'convenience';
  readonly target: Readonly<{
    toolName: ToolName;
    fixedArgs?: Readonly<Record<string, unknown>>;
    workflowCommand?: Command;
  }>;
  readonly visibility: 'primary' | 'visible_alias' | 'compatibility';
  readonly presentationGroup: PresentationGroup;
  /** Presentation copy for operational interfaces. */
  readonly description: string;
  /** Host-neutral semantic action identity (PR 6). */
  readonly intent?: import('../presentation/action-intent.js').ActionIntent;
}

function aliasKind(alias: keyof typeof COMMAND_ALIASES): InstalledCommandDefinition['kind'] {
  return COMMAND_ALIASES[alias]!.kind;
}

/** Every installed template has at least one stable public-interface identity. */
export const INSTALLED_COMMANDS: readonly InstalledCommandDefinition[] = [
  {
    id: 'workflow.hydrate',
    templateFile: 'hydrate.md',
    invocation: '/hydrate',
    kind: 'workflow',
    target: { toolName: TOOL_FLOWGUARD_HYDRATE, workflowCommand: Command.HYDRATE },
    visibility: 'compatibility',
    presentationGroup: 'start',
    description: 'Prepare or restore a governed session.',
    intent: 'refresh_repository',
  },
  {
    id: 'operational.status',
    templateFile: 'status.md',
    invocation: '/status',
    kind: 'operational',
    target: { toolName: TOOL_FLOWGUARD_STATUS },
    visibility: 'primary',
    presentationGroup: 'information',
    description: 'Show the current phase and next action.',
    intent: 'inspect_status',
  },
  {
    id: 'workflow.ticket',
    templateFile: 'ticket.md',
    invocation: '/ticket',
    kind: 'workflow',
    target: { toolName: TOOL_FLOWGUARD_TICKET, workflowCommand: Command.TICKET },
    visibility: 'compatibility',
    presentationGroup: 'start',
    description: 'Record the task that the workflow will govern.',
  },
  {
    id: 'workflow.plan',
    templateFile: 'plan.md',
    invocation: '/plan',
    kind: 'workflow',
    target: { toolName: TOOL_FLOWGUARD_PLAN, workflowCommand: Command.PLAN },
    visibility: 'primary',
    presentationGroup: 'work',
    description: 'Create or revise the implementation plan.',
  },
  {
    id: 'workflow.continue',
    templateFile: 'continue.md',
    invocation: '/continue',
    kind: 'workflow',
    target: { toolName: TOOL_FLOWGUARD_CONTINUE, workflowCommand: Command.CONTINUE },
    visibility: 'primary',
    presentationGroup: 'work',
    description: 'Route to the next workflow step.',
  },
  {
    id: 'workflow.implement',
    templateFile: 'implement.md',
    invocation: '/implement',
    kind: 'workflow',
    target: { toolName: TOOL_FLOWGUARD_IMPLEMENT, workflowCommand: Command.IMPLEMENT },
    visibility: 'primary',
    presentationGroup: 'work',
    description: 'Record implementation evidence for the approved plan.',
  },
  {
    id: 'workflow.extend-implementation-review',
    templateFile: 'extend-implementation-review.md',
    invocation: '/extend-implementation-review',
    kind: 'workflow',
    target: {
      toolName: TOOL_FLOWGUARD_EXTEND_IMPLEMENTATION_REVIEW,
      workflowCommand: Command.EXTEND_IMPLEMENTATION_REVIEW,
    },
    visibility: 'compatibility',
    presentationGroup: 'recovery',
    description: 'Authorize a finite extension to an exhausted implementation review budget.',
  },
  {
    id: 'workflow.resolve-implementation-challenge',
    templateFile: 'resolve-implementation-challenge.md',
    invocation: '/resolve-implementation-challenge',
    kind: 'workflow',
    target: {
      toolName: TOOL_FLOWGUARD_RESOLVE_IMPLEMENTATION_CHALLENGE,
      workflowCommand: Command.RESOLVE_IMPLEMENTATION_CHALLENGE,
    },
    visibility: 'compatibility',
    presentationGroup: 'review',
    description: 'Record evidence addressing an implementation review challenge.',
  },
  {
    id: 'workflow.validate',
    templateFile: 'validate.md',
    invocation: '/validate',
    kind: 'workflow',
    target: { toolName: TOOL_FLOWGUARD_RUN_CHECK, workflowCommand: Command.VALIDATE },
    visibility: 'compatibility',
    presentationGroup: 'verify',
    description: 'Record required verification results.',
    intent: 'run_validation',
  },
  {
    id: 'workflow.review-decision',
    templateFile: 'review-decision.md',
    invocation: '/review-decision',
    kind: 'workflow',
    target: { toolName: TOOL_FLOWGUARD_DECISION, workflowCommand: Command.REVIEW_DECISION },
    visibility: 'compatibility',
    presentationGroup: 'review',
    description: 'Record the human decision at a review gate.',
  },
  {
    id: 'workflow.review',
    templateFile: 'review.md',
    invocation: '/review',
    kind: 'workflow',
    target: { toolName: TOOL_FLOWGUARD_REVIEW, workflowCommand: Command.REVIEW },
    visibility: 'primary',
    presentationGroup: 'review',
    description: 'Start a standalone compliance review.',
    intent: 'rerun_review',
  },
  {
    id: 'workflow.architecture',
    templateFile: 'architecture.md',
    invocation: '/architecture',
    kind: 'workflow',
    target: { toolName: TOOL_FLOWGUARD_ARCHITECTURE, workflowCommand: Command.ARCHITECTURE },
    visibility: 'primary',
    presentationGroup: 'review',
    description: 'Create or revise an architecture decision record.',
  },
  {
    id: 'workflow.abort',
    templateFile: 'abort.md',
    invocation: '/abort',
    kind: 'workflow',
    target: { toolName: TOOL_FLOWGUARD_ABORT, workflowCommand: Command.ABORT },
    visibility: 'primary',
    presentationGroup: 'recovery',
    description: 'End the current workflow without presenting it as completed.',
  },
  {
    id: 'operational.archive',
    templateFile: 'archive.md',
    invocation: '/archive',
    kind: 'operational',
    target: { toolName: TOOL_FLOWGUARD_ARCHIVE },
    visibility: 'visible_alias',
    presentationGroup: 'export',
    description:
      'Archive session as tar.gz (redactionMode: none|basic|pseudonymous, default basic; includeRaw: true|false, default false).',
    intent: 'export_result',
  },
  {
    id: 'alias.start',
    templateFile: 'start.md',
    invocation: '/start',
    kind: aliasKind('start'),
    target: { toolName: TOOL_FLOWGUARD_HYDRATE, workflowCommand: Command.HYDRATE },
    visibility: 'primary',
    presentationGroup: 'start',
    description: 'Prepare or restore a governed session.',
    intent: 'refresh_repository',
  },
  {
    id: 'alias.task',
    templateFile: 'task.md',
    invocation: '/task',
    kind: aliasKind('task'),
    target: { toolName: TOOL_FLOWGUARD_TICKET, workflowCommand: Command.TICKET },
    visibility: 'primary',
    presentationGroup: 'start',
    description: 'Record the task that the workflow will govern.',
  },
  {
    id: 'variant.approve',
    templateFile: 'approve.md',
    invocation: '/approve',
    kind: aliasKind('approve'),
    target: {
      toolName: TOOL_FLOWGUARD_DECISION,
      fixedArgs: COMMAND_ALIASES.approve!.defaultArgs,
      workflowCommand: Command.REVIEW_DECISION,
    },
    visibility: 'primary',
    presentationGroup: 'review',
    description: 'Accept the reviewed work and advance.',
    intent: 'approve',
  },
  {
    id: 'variant.request-changes',
    templateFile: 'request-changes.md',
    invocation: '/request-changes',
    kind: aliasKind('request-changes'),
    target: {
      toolName: TOOL_FLOWGUARD_DECISION,
      fixedArgs: COMMAND_ALIASES['request-changes']!.defaultArgs,
      workflowCommand: Command.REVIEW_DECISION,
    },
    visibility: 'primary',
    presentationGroup: 'review',
    description: 'Request revisions to the reviewed work.',
    intent: 'request_changes',
  },
  {
    id: 'variant.reject',
    templateFile: 'reject.md',
    invocation: '/reject',
    kind: aliasKind('reject'),
    target: {
      toolName: TOOL_FLOWGUARD_DECISION,
      fixedArgs: COMMAND_ALIASES.reject!.defaultArgs,
      workflowCommand: Command.REVIEW_DECISION,
    },
    visibility: 'primary',
    presentationGroup: 'review',
    description: 'Reject the reviewed work.',
    intent: 'reject',
  },
  {
    id: 'alias.check',
    templateFile: 'check.md',
    invocation: '/check',
    kind: aliasKind('check'),
    target: { toolName: TOOL_FLOWGUARD_RUN_CHECK, workflowCommand: Command.VALIDATE },
    visibility: 'primary',
    presentationGroup: 'verify',
    description: 'Run required verification checks.',
    intent: 'run_validation',
  },
  {
    id: 'alias.export',
    templateFile: 'export.md',
    invocation: '/export',
    kind: aliasKind('export'),
    target: { toolName: TOOL_FLOWGUARD_ARCHIVE },
    visibility: 'primary',
    presentationGroup: 'export',
    description:
      'Export audit package as tar.gz (redactionMode: none|basic|pseudonymous, default basic; includeRaw: true|false, default false).',
    intent: 'export_result',
  },
  {
    id: 'alias.why',
    templateFile: 'why.md',
    invocation: '/why',
    kind: aliasKind('why'),
    target: { toolName: TOOL_FLOWGUARD_STATUS, fixedArgs: COMMAND_ALIASES.why!.defaultArgs },
    visibility: 'primary',
    presentationGroup: 'information',
    description: 'Explain the current runtime blocker.',
    intent: 'inspect_blocker',
  },
  {
    id: 'operational.finish',
    templateFile: 'finish.md',
    invocation: '/finish',
    kind: 'operational',
    target: { toolName: TOOL_FLOWGUARD_STATUS, fixedArgs: { finish: true } },
    visibility: 'primary',
    presentationGroup: 'complete',
    description: 'Show completion readiness without changing the workflow.',
  },
  {
    id: 'operational.reconcile-mutation-episode',
    templateFile: 'reconcile-mutation-episode.md',
    invocation: '/reconcile-mutation-episode',
    kind: 'operational',
    target: { toolName: TOOL_FLOWGUARD_RECONCILE_MUTATION_EPISODE },
    visibility: 'primary',
    presentationGroup: 'recovery',
    description: 'Resolve a host mutation episode whose outcome can never be observed.',
  },
  {
    id: 'operational.help.context',
    templateFile: 'help.md',
    invocation: '/help',
    kind: 'operational',
    target: { toolName: TOOL_FLOWGUARD_HELP, fixedArgs: { view: 'context' } },
    visibility: 'primary',
    presentationGroup: 'information',
    description: 'Show concise help for the current situation.',
  },
  {
    id: 'operational.help.commands',
    templateFile: 'commands.md',
    invocation: '/commands',
    kind: 'operational',
    target: { toolName: TOOL_FLOWGUARD_HELP, fixedArgs: { view: 'commands', scope: 'available' } },
    visibility: 'primary',
    presentationGroup: 'information',
    description: 'List FlowGuard commands for the current context.',
  },
  {
    id: 'operational.help.commands-all',
    templateFile: 'commands.md',
    invocation: '/commands --all',
    kind: 'operational',
    target: { toolName: TOOL_FLOWGUARD_HELP, fixedArgs: { view: 'commands', scope: 'all' } },
    visibility: 'primary',
    presentationGroup: 'information',
    description: 'Show the complete installed FlowGuard command reference.',
  },
];

/** Unique template files across all installed interface identities. */
export const INSTALLED_TEMPLATE_FILES: readonly string[] = [
  ...new Set(INSTALLED_COMMANDS.map((definition) => definition.templateFile)),
];

export function getInstalledCommand(invocation: string): InstalledCommandDefinition | undefined {
  return INSTALLED_COMMANDS.find((definition) => definition.invocation === invocation);
}

export function preferredInvocationForTool(toolName: ToolName): string | undefined {
  return INSTALLED_COMMANDS.find(
    (definition) => definition.target.toolName === toolName && definition.visibility === 'primary',
  )?.invocation;
}

/**
 * Visible alternative invocations for the same semantic target.
 * Derived from the canonical alias authority, never hard-coded.
 */
export function visibleAliasesForDefinition(
  definition: InstalledCommandDefinition,
): readonly string[] {
  if (definition.target.toolName !== TOOL_FLOWGUARD_ARCHIVE) return [];
  return INSTALLED_COMMANDS.filter(
    (candidate) =>
      candidate.target.toolName === definition.target.toolName &&
      candidate.invocation !== definition.invocation &&
      candidate.visibility !== 'compatibility',
  ).map((candidate) => candidate.invocation);
}

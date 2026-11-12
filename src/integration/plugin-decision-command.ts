/** Native commands call the canonical decision tool directly, never through a model prompt. */
import { randomUUID } from 'node:crypto';
import type { Plugin } from '@opencode/plugin';
import type { FlowGuardPluginRuntime } from './plugin-shared.js';
import type { ActiveGovernanceScope, OpenCodeGovernance } from './opencode-governance.js';
import { INSTALLED_COMMANDS } from './installed-commands.js';
import { TOOL_FLOWGUARD_DECISION } from './tool-names.js';
import { decision } from './tools/index.js';
import type { AutoValidationProgressEvent } from './tools/helpers.js';
import { ReviewVerdict } from '../state/evidence.js';
import { resolveWorkflowDirective } from '../machine/workflow-directive.js';
import { checkDecisionBinding, type DecisionBinding } from './status/decision-binding.js';
import {
  createDecisionOperation,
  DecisionArgsSchema,
  runWithDecisionInvocation,
  type DecisionArgs,
} from './workflow-decision-invocation.js';
import { buildEnforcementError, parseToolResult } from './blocked-result.js';
import { reconcilePendingAuditOperations } from './plugin-audit-reconcile.js';
import { toolBefore } from './plugin-beforehooks.js';
import { toolAfter } from './plugin-afterhooks.js';
import { recordPresentation, type PresentationStore } from './plugin-presentation.js';

export interface DecisionCommandDeps {
  readonly governance: Pick<
    OpenCodeGovernance,
    'assertScopeCurrent' | 'assertActivationAuditConfirmed'
  >;
  readonly guard: <T>(run: () => Promise<T>) => Promise<T>;
  readonly invoke: <T>(
    sessionId: string,
    run: (entry: {
      readonly runtime: FlowGuardPluginRuntime;
      readonly scope: ActiveGovernanceScope;
    }) => Promise<T>,
    required?: boolean,
  ) => Promise<T | undefined>;
  readonly signal: AbortSignal;
  /** Ephemeral host presentation; never workflow, audit or model authority. */
  readonly presentation: PresentationStore;
}
type CommandEditor = Parameters<Parameters<Plugin.Context['command']['transform']>[0]>[0];
export function addDecisionCommands(deps: DecisionCommandDeps, editor: CommandEditor): void {
  for (const command of INSTALLED_COMMANDS.filter(
    (command) => command.target.toolName === TOOL_FLOWGUARD_DECISION,
  ))
    editor.add({
      name: command.invocation.slice(1),
      description: command.description,
      execute: (input) =>
        deps.guard(() => {
          const fixed = command.target.fixedArgs?.verdict;
          const text = input.prompt.text.trim();
          const token = fixed ?? text.split(/\s+/, 1)[0];
          const args = DecisionArgsSchema.parse({
            verdict: ReviewVerdict.parse(token),
            rationale: fixed === undefined ? text.slice(String(token).length).trim() : text,
          });
          return executeDecisionCommand(deps, {
            sessionID: input.sessionID,
            command: command.invocation,
            args,
          });
        }),
    });
}

export async function executeDecisionCommand(
  deps: DecisionCommandDeps,
  request: {
    readonly sessionID: string;
    readonly command: string;
    readonly args: DecisionArgs;
    /** Present for native UI controls; absent for the canonical slash-command path. */
    readonly expectedBinding?: DecisionBinding;
  },
): Promise<void> {
  const { sessionID, args } = request;
  await deps.invoke(
    sessionID,
    async ({ runtime, scope }) => {
      if (scope.sessionId !== scope.root.sessionId)
        throw buildEnforcementError(
          'GOVERNANCE_AUTHORITY_BLOCKED',
          'A delegated child cannot decide its root workflow.',
        );
      const authority = await runtime.ws.resolveSessionAuthority(sessionID);
      if (authority.status !== 'resolved')
        throw buildEnforcementError(
          'GOVERNANCE_AUTHORITY_BLOCKED',
          'Decision workflow authority is unavailable.',
        );
      if (request.expectedBinding !== undefined) {
        const binding = checkDecisionBinding(request.expectedBinding, authority.state, scope.root);
        if (binding.kind === 'blocked') throw buildEnforcementError(binding.code, binding.reason);
        if (!resolveWorkflowDirective(authority.state).commands.includes(request.command))
          throw buildEnforcementError(
            'COMMAND_NOT_ALLOWED',
            'The selected decision is not an allowed action at the current gate.',
          );
      }
      const event = { tool: TOOL_FLOWGUARD_DECISION, sessionID, callID: randomUUID(), args };
      await toolBefore(runtime, event, { args });
      const operation = createDecisionOperation(scope.root, authority.state, args, 'host_command');
      const reconciliation = await reconcilePendingAuditOperations(
        runtime.auditDeps,
        sessionID,
        request.command,
      );
      if (reconciliation?.block)
        throw buildEnforcementError(reconciliation.code, reconciliation.reason);
      const output = await runWithDecisionInvocation(
        operation,
        async () => {
          await deps.governance.assertScopeCurrent(sessionID, scope);
          await deps.governance.assertActivationAuditConfirmed(scope.root);
        },
        () =>
          decision.execute(args, {
            sessionID,
            messageID: '',
            agent: '',
            directory: authority.worktreeRoot,
            worktree: authority.worktreeRoot,
            abort: deps.signal,
            metadata: () => {},
            autoValidationProgress: (event) =>
              presentValidationProgress(deps.presentation, sessionID, event),
          }),
      );
      const audited = {
        title: '',
        output: typeof output === 'string' ? output : output.output,
        metadata: {},
      };
      await toolAfter(runtime, event, audited);
      presentDecision(deps.presentation, sessionID, audited.output, args.verdict);
    },
    true,
  );
}

function verdictLabel(verdict: ReviewVerdict): string {
  if (verdict === 'approve') return 'approved';
  if (verdict === 'approve_with_governance_override') return 'approved with governance override';
  if (verdict === 'changes_requested') return 'changes requested';
  return 'rejected';
}

function presentationMarkdown(result: Record<string, unknown>): string | null {
  const presentation = result.presentation;
  if (presentation === null || typeof presentation !== 'object') return null;
  const markdown = (presentation as { markdown?: unknown }).markdown;
  return typeof markdown === 'string' ? markdown : null;
}

function directiveCommands(result: Record<string, unknown>): readonly string[] {
  const directive = result.directive;
  if (directive === null || typeof directive !== 'object') return [];
  const commands = (directive as { commands?: unknown }).commands;
  if (!Array.isArray(commands)) return [];
  return commands.filter((command): command is string => typeof command === 'string');
}

function decisionConfirmation(result: Record<string, unknown>, verdict: ReviewVerdict): string {
  const phase = typeof result.phase === 'string' ? `; current phase \`${result.phase}\`` : '';
  const summary = `**Decision recorded:** ${verdictLabel(verdict)}${phase}.`;
  const instruction =
    "This is a FlowGuard host status report, not a request to continue. Wait for the user's explicit next command.";
  const markdown = presentationMarkdown(result);
  if (markdown !== null) return `${summary}\n\n${markdown}\n\n${instruction}`;
  const commands = directiveCommands(result);
  const next =
    commands.length === 0 ? '' : `\n\n## Next\n\n${commands.map((c) => `- \`${c}\``).join('\n')}`;
  const status = typeof result.status === 'string' ? result.status : 'The decision is durable.';
  return `${summary}\n\n${status}${next}\n\n${instruction}`;
}

function presentValidationProgress(
  presentation: PresentationStore,
  sessionID: string,
  event: AutoValidationProgressEvent,
): void {
  const message =
    event.stage === 'check_started' && event.check !== undefined
      ? `**Validation in progress** — preparing \`${event.check}\` check.`
      : event.stage === 'check_finished' && event.check !== undefined
        ? `**Validation in progress** — \`${event.check}\` returned; the canonical check result remains authoritative.`
        : `**Validation started** — preparing ${event.checks.map((check) => `\`${check}\``).join(', ')}.`;
  recordPresentation(presentation, sessionID, {
    kind: 'validation',
    message,
    phase: event.phase,
    checks: event.checks,
  });
}

function presentDecision(
  presentation: PresentationStore,
  sessionID: string,
  output: string,
  verdict: ReviewVerdict,
): void {
  const result = parseToolResult(output);
  if (result === null)
    throw buildEnforcementError(
      'PLUGIN_ENFORCEMENT_UNAVAILABLE',
      'The decision result is unreadable.',
    );
  if (result.error === true)
    throw buildEnforcementError(
      typeof result.code === 'string' ? result.code : 'GOVERNANCE_AUTHORITY_BLOCKED',
      typeof result.message === 'string' ? result.message : output,
    );
  recordPresentation(presentation, sessionID, {
    kind: 'decision',
    message: decisionConfirmation(result, verdict),
    ...(typeof result.phase === 'string' ? { phase: result.phase } : {}),
  });
}

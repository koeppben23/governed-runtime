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

interface DecisionCommandDeps {
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
}
type CommandEditor = Parameters<Parameters<Plugin.Context['command']['transform']>[0]>[0];
export function addDecisionCommands(
  ctx: Plugin.Context,
  deps: DecisionCommandDeps,
  editor: CommandEditor,
): void {
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
          return executeDecisionCommand(ctx, deps, {
            sessionID: input.sessionID,
            command: command.invocation,
            args,
          });
        }),
    });
}

export async function executeDecisionCommand(
  ctx: Plugin.Context,
  deps: DecisionCommandDeps,
  request: { readonly sessionID: string; readonly command: string; readonly args: DecisionArgs },
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
      const event = { tool: TOOL_FLOWGUARD_DECISION, sessionID, callID: randomUUID(), args };
      await toolBefore(runtime, event, { args });
      const authority = await runtime.ws.resolveSessionAuthority(sessionID);
      if (authority.status !== 'resolved')
        throw buildEnforcementError(
          'GOVERNANCE_AUTHORITY_BLOCKED',
          'Decision workflow authority is unavailable.',
        );
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
            autoValidationProgress: (event) => presentValidationProgress(ctx, sessionID, event),
          }),
      );
      const audited = {
        title: '',
        output: typeof output === 'string' ? output : output.output,
        metadata: {},
      };
      await toolAfter(runtime, event, audited);
      await presentDecision(ctx, sessionID, audited.output, args.verdict);
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

async function presentValidationProgress(
  ctx: Plugin.Context,
  sessionID: string,
  event: AutoValidationProgressEvent,
): Promise<void> {
  const checks = event.checks.map((check) => `\`${check}\``).join(', ');
  try {
    await ctx.session.prompt({
      sessionID,
      text: `**Validation started** — running ${checks}. Results will follow automatically.`,
    });
  } catch (error) {
    console.warn('[FlowGuard] Validation is running; the progress presentation failed.', error);
  }
}

async function presentDecision(
  ctx: Plugin.Context,
  sessionID: string,
  output: string,
  verdict: ReviewVerdict,
): Promise<void> {
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
  try {
    await ctx.session.prompt({
      sessionID,
      text: decisionConfirmation(result, verdict),
    });
  } catch (error) {
    console.warn(
      '[FlowGuard] Decision is committed and audited; status presentation failed.',
      error,
    );
  }
}

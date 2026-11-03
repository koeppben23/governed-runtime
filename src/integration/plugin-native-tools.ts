/** Native catalogue/executor composition. Only inert help is initially public;
 * per-request filtering preserves mixed-session INACTIVE provider-wire parity. */
import type { Plugin } from '@opencode/plugin';
import type { ToolContext as NativeToolContext } from '@opencode/plugin/promise/tool';
import type { SessionContext } from '@opencode/plugin/promise/session';
import { z } from 'zod';
import { listActiveGovernanceRoots } from '../adapters/governance-activation.js';
import {
  FLOWGUARD_TOOL_NAMES,
  FLOWGUARD_TOOL_PREFIX,
  TOOL_FLOWGUARD_HELP,
  TOOL_FLOWGUARD_OBSERVE_REPOSITORY,
} from './tool-names.js';
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';
import type { ActiveGovernanceScope } from './opencode-governance.js';
import * as tools from './tools/index.js';
import type { ToolDefinition } from './tools/helpers.js';
import type { FlowGuardPluginRuntime } from './plugin-shared.js';
import { buildEnforcementError } from './blocked-result.js';
import { encodeHostCallId } from '../state/host-identity.js';
import { toolAfter } from './plugin-afterhooks.js';
import { reconcileHostMutationEpisodes } from './plugin-mutation-reconciliation.js';

export type NativeRegistration = { dispose(): Promise<void> };
export type NativeCanonicalExecutor = (
  name: string,
  definition: ToolDefinition,
  args: unknown,
  context: NativeToolContext,
) => Promise<{ content: string; metadata: Record<string, unknown> }>;

/** The only productive FlowGuard tool permitted to a delegated reviewer. */
export function isDelegatedWorkflowDecision(
  scope: ActiveGovernanceScope,
  event: { readonly tool: string; readonly agent: string },
): boolean {
  return (
    scope.sessionId !== scope.root.sessionId &&
    event.tool !== TOOL_FLOWGUARD_HELP &&
    !(event.tool === TOOL_FLOWGUARD_OBSERVE_REPOSITORY && event.agent === REVIEWER_SUBAGENT_TYPE)
  );
}

export async function createNativeToolCatalogue(
  ctx: Plugin.Context,
  registrations: NativeRegistration[],
  execute: NativeCanonicalExecutor,
) {
  const definitions = FLOWGUARD_TOOL_NAMES.map((name) => {
    const definition = tools[
      name.slice(FLOWGUARD_TOOL_PREFIX.length) as keyof typeof tools
    ] as ToolDefinition;
    if (!definition || typeof definition.execute !== 'function' || !definition.args) {
      throw buildEnforcementError(
        'PLUGIN_ENFORCEMENT_UNAVAILABLE',
        `No canonical implementation for ${name}.`,
      );
    }
    const schema = z.object(definition.args);
    return { name, definition, schema, input: z.toJSONSchema(schema, { io: 'input' }) };
  });
  const publish = async (productive: boolean) => {
    registrations.push(
      await ctx.tool.transform((editor) => {
        for (const item of definitions) {
          if ((item.name !== TOOL_FLOWGUARD_HELP) !== productive) continue;
          editor.add({
            name: item.name,
            description: item.definition.description,
            input: item.input,
            options: { codemode: false },
            execute: (args, context) =>
              execute(item.name, item.definition, item.schema.parse(args), context),
          });
        }
      }),
    );
  };
  await publish(false);
  let publication: Promise<void> | undefined;
  let published = false;
  const ensurePublished = async () => {
    if (!publication) {
      publication = publish(true).then(() => {
        published = true;
      });
      void publication.catch(() => {
        publication = undefined;
      });
    }
    await publication;
  };
  const roots = await listActiveGovernanceRoots(ctx.storage);
  for (const error of roots.errors)
    console.error('[FlowGuard] Activation catalogue restoration blocked for a scope', error);
  if (roots.records.some((record) => record.directory === ctx.location.directory))
    await ensurePublished();
  return {
    get published() {
      return published;
    },
    ensurePublished,
    hideProductive(view: Pick<SessionContext, 'tools'>, observation = false) {
      for (const name of FLOWGUARD_TOOL_NAMES)
        if (
          name !== TOOL_FLOWGUARD_HELP &&
          !(observation && name === TOOL_FLOWGUARD_OBSERVE_REPOSITORY)
        )
          delete view.tools[name];
    },
  };
}

export async function executeCanonicalNativeTool(
  name: string,
  definition: ToolDefinition,
  args: unknown,
  context: NativeToolContext,
  entry: { readonly runtime: FlowGuardPluginRuntime; readonly scope: ActiveGovernanceScope },
) {
  const { runtime, scope } = entry;
  if (isDelegatedWorkflowDecision(scope, { tool: name, agent: context.agent }))
    throw buildEnforcementError(
      'GOVERNANCE_AUTHORITY_BLOCKED',
      'Delegated host execution does not authorize parent workflow decisions.',
    );
  const authority = await runtime.ws.resolveSessionAuthority(scope.root.sessionId);
  if (authority.status === 'unavailable')
    throw buildEnforcementError(authority.code, authority.reason);
  if (authority.status !== 'resolved')
    throw buildEnforcementError(
      'SESSION_DIR_NOT_FOUND',
      'The ACTIVE workflow state is missing; hydrate cannot recreate activation authority.',
    );
  let metadata: Record<string, unknown> = {};
  const result = await definition.execute(args, {
    sessionID: context.sessionID,
    messageID: context.messageID,
    agent: context.agent,
    directory: authority.worktreeRoot,
    worktree: authority.worktreeRoot,
    abort: context.signal,
    metadata: (update) => {
      metadata = {
        ...metadata,
        ...update.metadata,
        ...(update.title === undefined ? {} : { title: update.title }),
      };
    },
  });
  return typeof result === 'string'
    ? { content: result, metadata }
    : { content: result.output, metadata: { ...metadata, ...result.metadata } };
}

type Completion = Extract<
  Parameters<Parameters<Plugin.Context['tool']['hook']>[1]>[0],
  { status: 'completed' }
>;
type NativeCompletion = Extract<
  Parameters<Parameters<Plugin.Context['tool']['hook']>[1]>[0],
  { status: string }
>;

export async function handleNativeCompletion(
  runtime: FlowGuardPluginRuntime,
  sessionId: string,
  event: NativeCompletion,
): Promise<void> {
  const hostCallId = encodeHostCallId(event.sessionID, event.messageID, event.id);
  if (event.status === 'error') {
    await reconcileHostMutationEpisodes(runtime, sessionId, hostCallId);
    return;
  }
  if (typeof event.input !== 'object' || event.input === null || Array.isArray(event.input))
    throw buildEnforcementError(
      'PLUGIN_ENFORCEMENT_UNAVAILABLE',
      'The governed tool completion input is not an object.',
    );
  const content = event.result.content;
  const output = {
    title: '',
    output: nativeCompletionText(content),
    metadata: { ...event.result.metadata },
  };
  await toolAfter(
    runtime,
    {
      tool: applicationTool(event.tool),
      sessionID: sessionId,
      callID: hostCallId,
      args: event.input,
    },
    output,
  );
  event.result = {
    ...event.result,
    content:
      typeof content === 'object'
        ? content.map((part) => (part.type === 'text' ? { ...part, text: output.output } : part))
        : output.output,
    metadata: output.metadata,
  };
}

/** Current native shell identity projected into the application classifier. */
export function applicationTool(tool: string): string {
  return tool === 'shell' ? 'bash' : tool;
}
/** A semantic text view, never concatenation or replacement of native evidence. */
function nativeCompletionText(content: Completion['result']['content']): string {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content))
    throw buildEnforcementError(
      'PLUGIN_ENFORCEMENT_UNAVAILABLE',
      'Native tool completion content is neither text nor a content array.',
    );
  if (
    content.some(
      (part) =>
        !part ||
        typeof part !== 'object' ||
        (part.type === 'text'
          ? typeof part.text !== 'string'
          : part.type !== 'file' || typeof part.uri !== 'string' || typeof part.mime !== 'string'),
    )
  ) {
    throw buildEnforcementError(
      'PLUGIN_ENFORCEMENT_UNAVAILABLE',
      'Native tool completion contains a malformed content part.',
    );
  }
  const textParts = content.filter((part) => part.type === 'text');
  const text = textParts[0];
  if (!text || textParts.length !== 1)
    throw buildEnforcementError(
      'PLUGIN_ENFORCEMENT_UNAVAILABLE',
      'Rich tool completion requires exactly one unambiguous text part.',
    );
  return text.text;
}

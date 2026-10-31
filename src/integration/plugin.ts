/** Native OpenCode V2 composition. Governance decisions remain in their canonical owners. */
import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { Plugin } from '@opencode/plugin';
import type { OpenCodeEvent } from '@opencode/client';
import type { ToolContext as NativeToolContext } from '@opencode/plugin/promise/tool';
import { z } from 'zod';
import { HttpTimestampAuthorityProvider } from '../audit/rfc-3161-http-provider.js';
import { PkijsTimestampVerifier } from '../audit/rfc-3161-pkijs-verifier.js';
import { repoConfigPath } from '../adapters/persistence.js';
import { resolveSessionAuthority } from '../adapters/session-authority.js';
import { toAdapterLogger } from '../logging/adapter-logger.js';
import { serializeError } from '../logging/error-serialize.js';
import { toolBefore } from './plugin-beforehooks.js';
import { toolAfter, handlePluginEvent, handleCompaction } from './plugin-afterhooks.js';
import { createPluginLogger } from './plugin-logging.js';
import { resolvePluginSessionPolicy } from './plugin-policy.js';
import type { FlowGuardPluginRuntime } from './plugin-shared.js';
import {
  OpenCodeHostAdapter,
  HostCapabilityMismatchError,
  projectOpenCodeEvent,
} from './opencode-host-adapter.js';
import { createWorkspace } from './plugin-workspace.js';
import { ReviewerCaptureController } from './reviewer-capture.js';
import { validateNativeReviewerOutputLimit } from './reviewer-output-cap.js';
import { buildEnforcementError } from './blocked-result.js';
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';
import { reconcileHostMutationEpisodes } from './plugin-mutation-reconciliation.js';
import {
  FLOWGUARD_TOOL_NAMES,
  FLOWGUARD_TOOL_PREFIX,
  TOOL_FLOWGUARD_HYDRATE,
} from './tool-names.js';
import * as tools from './tools/index.js';
import type { ToolDefinition } from './tools/helpers.js';

export function isUsableWorktree(worktree: string | undefined): boolean {
  if (!worktree) return false;
  const normalized = path.resolve(worktree);
  if (normalized === '/' || /^[A-Za-z]:[\\/]?$/.test(normalized)) return false;
  try {
    return existsSync(normalized) && statSync(normalized).isDirectory();
  } catch {
    return false;
  }
}

class PluginCleanupError extends AggregateError {
  readonly code = 'PLUGIN_CLEANUP_FAILED';
}

type Registration = { dispose(): Promise<void> };
type NativeToolCompletion = Extract<
  Parameters<Parameters<Plugin.Context['tool']['hook']>[1]>[0],
  { readonly status: string }
>;
type RuntimeEntry = {
  readonly runtime: FlowGuardPluginRuntime;
  readonly dispose: () => Promise<void>;
  readonly reviewerOutputLimit: number | 'host';
  readonly configReadError?: unknown;
};

/** This is the only OpenCode entrypoint. There is deliberately no callable V1 factory. */
export const FlowGuardAuditPlugin = Plugin.define({
  id: 'flowguard',
  async setup(ctx) {
    const controller = new AbortController();
    const adapter = new OpenCodeHostAdapter(ctx, controller.signal);
    const registrations: Registration[] = [];
    const runtimes = new Map<string, Promise<RuntimeEntry>>();
    const sessionRoots = new Map<string, string>();
    const operations = new Set<Promise<unknown>>();
    let ready = false;
    let closed = false;
    let eventFailed = false;
    let eventLoop: Promise<void> | undefined;
    let cleanup: Promise<void> | undefined;

    const assertAvailable = (): void => {
      if (!ready || closed || eventFailed) {
        throw buildEnforcementError(
          'PLUGIN_ENFORCEMENT_UNAVAILABLE',
          'The V2 plugin is not ready, has stopped, or lost its event stream.',
        );
      }
    };

    const invoke = async <T>(
      sessionId: string,
      action: (entry: RuntimeEntry) => Promise<T>,
    ): Promise<T> => {
      assertAvailable();
      const operation = loadRuntime(adapter, runtimes, sessionRoots, sessionId).then((entry) => {
        assertAvailable();
        return action(entry);
      });
      operations.add(operation);
      try {
        return await operation;
      } finally {
        operations.delete(operation);
      }
    };

    const dispose = (): Promise<void> => {
      cleanup ??= (async () => {
        closed = true;
        controller.abort();
        await disposeResources(registrations, runtimes, operations, eventLoop, adapter);
      })();
      return cleanup;
    };

    try {
      await adapter.initialize();
      const capabilities = await adapter.validateCapabilities();
      if (!capabilities.valid) throw new HostCapabilityMismatchError(capabilities.mismatches);
      await createFlowGuardPluginHooks(ctx, invoke, registrations);
      eventLoop = consumeEvents(
        ctx,
        controller.signal,
        (event) => dispatchEvent(event, runtimes, sessionRoots, invoke),
        (error) => {
          eventFailed = true;
          adapter.log('error', 'V2 event stream unavailable', serializeError(error));
        },
        operations,
      );
      ready = true;
      return dispose;
    } catch (error) {
      try {
        await dispose();
      } catch (cleanupError) {
        throw new PluginCleanupError(
          [error, cleanupError],
          'V2 setup failed and cleanup was incomplete.',
        );
      }
      throw error;
    }
  },
});

export default FlowGuardAuditPlugin;

async function loadRuntime(
  adapter: OpenCodeHostAdapter,
  runtimes: Map<string, Promise<RuntimeEntry>>,
  sessionRoots: Map<string, string>,
  sessionId: string,
): Promise<RuntimeEntry> {
  const session = await adapter.getSession(sessionId);
  const authority = await resolveSessionAuthority({ root: session.directory, sessionId });
  if (authority.status === 'unavailable')
    throw buildEnforcementError(authority.code, authority.reason);
  const root = authority.worktreeRoot;
  sessionRoots.set(sessionId, root);
  let entry = runtimes.get(root);
  if (!entry) {
    entry = createSessionRuntime(adapter, root);
    runtimes.set(root, entry);
  }
  return entry;
}

async function disposeResources(
  registrations: readonly Registration[],
  runtimes: ReadonlyMap<string, Promise<RuntimeEntry>>,
  operations: ReadonlySet<Promise<unknown>>,
  eventLoop: Promise<void> | undefined,
  adapter: OpenCodeHostAdapter,
): Promise<void> {
  const registrationsDisposed = await Promise.allSettled(
    registrations.map((registration) => registration.dispose()),
  );
  if (eventLoop) await eventLoop;
  await Promise.allSettled([...operations]);
  const runtimesDisposed = await Promise.allSettled([
    ...[...runtimes.values()].map(async (entry) => (await entry).dispose()),
    adapter.shutdown(),
  ]);
  const errors = [...registrationsDisposed, ...runtimesDisposed].flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (errors.length > 0)
    throw new PluginCleanupError(errors, 'OpenCode V2 plugin cleanup was incomplete.');
}

async function dispatchEvent(
  event: OpenCodeEvent,
  runtimes: ReadonlyMap<string, Promise<RuntimeEntry>>,
  sessionRoots: Map<string, string>,
  invoke: Invoke,
): Promise<void> {
  const projected = projectOpenCodeEvent(event);
  if (!projected) return;
  if (event.type === 'session.deleted') {
    const root = sessionRoots.get(projected.sessionId);
    const entry = root === undefined ? undefined : runtimes.get(root);
    if (entry) await handlePluginEvent((await entry).runtime, projected.event);
    sessionRoots.delete(projected.sessionId);
    return;
  }
  await invoke(projected.sessionId, (entry) => handlePluginEvent(entry.runtime, projected.event));
}

async function createSessionRuntime(
  adapter: OpenCodeHostAdapter,
  root: string,
): Promise<RuntimeEntry> {
  if (!isUsableWorktree(root))
    throw buildEnforcementError(
      'PLUGIN_ENFORCEMENT_UNAVAILABLE',
      'The host session has no usable worktree.',
    );
  const ws = createWorkspace({ auditWorktree: root });
  await ws.resolveFingerprint();
  const { log, config, configReadError, disposeLogging } = await createPluginLogger(
    undefined,
    ws.cachedWsDir,
    root,
    ws.cachedFingerprint,
    repoConfigPath(root),
  );
  try {
    const resolvePolicy: FlowGuardPluginRuntime['auditDeps']['resolveSessionPolicy'] = (sessDir) =>
      resolvePluginSessionPolicy({ sessDir, configDefaultMode: config.policy.defaultMode, log });
    const logError = (message: string, error: unknown) =>
      log.error('audit', message, { error: serializeError(error) });
    const runtime: FlowGuardPluginRuntime = {
      ws,
      log,
      adapterLog: toAdapterLogger(log),
      riskDeps: {
        resolveSessionAuthority: (sid) => ws.resolveSessionAuthority(sid),
        getWorktreeRoot: () => root,
      },
      discoveryHealthDeps: {
        resolveSessionAuthority: (sid) => ws.resolveSessionAuthority(sid),
        getWorkspaceDir: () => ws.cachedWsDir,
      },
      orchestratorDeps: {
        reviewerCapture: new ReviewerCaptureController(),
        resolveSessionAuthority: (sid) => ws.resolveSessionAuthority(sid),
        updateReviewAssurance: ws.updateReviewAssurance,
        blockReviewOutcome: ws.blockReviewOutcome,
        getEnforcementState: ws.getEnforcementState,
        log,
        client: adapter,
      },
      auditDeps: {
        resolveSessionAuthority: (sid) => ws.resolveSessionAuthority(sid),
        resolveSessionPolicy: resolvePolicy,
        initChain: ws.initChain,
        invalidateChainState: ws.invalidateChainState,
        appendAndTrack: ws.appendAndTrack,
        nextDecisionSequence: ws.nextDecisionSequence,
        log,
        logError,
        mode: config.policy.defaultMode ?? 'team',
        tsaProvider: new HttpTimestampAuthorityProvider(),
        timestampVerifier: new PkijsTimestampVerifier(),
      },
      toolTraceIds: new Map(),
      toolLatencyStarts: new Map(),
      activeCommandScopes: new Map(),
      checkReworkContinuations: new Set(),
      reviewerOutputCapFailures: new Map(),
      reviewerExecutionFailures: new Map(),
      reviewerExecutionTimeoutMs: config.reviewer.executionTimeoutMs,
      logError,
    };
    return {
      runtime,
      dispose: async () => {
        await disposeLogging?.();
      },
      reviewerOutputLimit: config.reviewer.outputTokenMax,
      ...(configReadError === undefined ? {} : { configReadError }),
    };
  } catch (error) {
    await disposeLogging?.();
    throw error;
  }
}

type Invoke = <T>(sessionId: string, action: (entry: RuntimeEntry) => Promise<T>) => Promise<T>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Native names are translated to the existing application tool vocabulary, not accepted as V1 API input. */
function applicationTool(tool: string): string {
  return tool === 'shell' ? 'bash' : tool;
}

function assertReviewerBoundary(tool: string, input: unknown): void {
  if (tool === 'subagent' && record(input) && input.agent === REVIEWER_SUBAGENT_TYPE) {
    throw buildEnforcementError(
      'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
      'The V2 reviewer release/completion/capture chain is NOT_VERIFIED.',
    );
  }
}

/** Register each native hook exactly once; there is no intermediate SDK hook object. */
async function createFlowGuardPluginHooks(
  ctx: Plugin.Context,
  invoke: Invoke,
  registrations: Registration[],
): Promise<void> {
  registrations.push(
    await ctx.tool.hook('execute.before', (event) =>
      invoke(event.sessionID, async ({ runtime }) => {
        runtime.orchestratorDeps.reviewerCapture?.beforeTool({ sessionID: event.sessionID });
        assertReviewerBoundary(event.tool, event.input);
        if (!record(event.input))
          throw buildEnforcementError(
            'PLUGIN_ENFORCEMENT_UNAVAILABLE',
            'The governed tool input is not an object.',
          );
        if (event.tool === TOOL_FLOWGUARD_HYDRATE) {
          const authority = await runtime.ws.resolveSessionAuthority(event.sessionID);
          if (authority.status !== 'resolved')
            throw buildEnforcementError(
              'PLUGIN_ENFORCEMENT_UNAVAILABLE',
              'Hydrate cannot create activation; distinguishable operator UI provenance is NOT_VERIFIED.',
            );
        }
        const output = { args: event.input };
        await toolBefore(
          runtime,
          { tool: applicationTool(event.tool), sessionID: event.sessionID, callID: event.id },
          output,
        );
        event.input = output.args;
      }),
    ),
  );
  registrations.push(
    await ctx.tool.hook('execute.after', (event) =>
      invoke(event.sessionID, ({ runtime }) => handleNativeCompletion(runtime, event)),
    ),
  );
  registrations.push(
    await ctx.session.hook('context', (event) =>
      invoke(event.sessionID, async (entry) => {
        if (event.agent === REVIEWER_SUBAGENT_TYPE) {
          validateNativeReviewerOutputLimit(entry.reviewerOutputLimit, entry.configReadError);
          throw buildEnforcementError(
            'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
            'A V2 context callback alone cannot attest reviewer completion or capture.',
          );
        }
      }),
    ),
  );
  registrations.push(
    await ctx.session.hook('compaction', (event) =>
      invoke(event.sessionID, async ({ runtime }) => {
        const output = { context: [] as string[] };
        await handleCompaction(runtime, { sessionID: event.sessionID }, output);
        if (output.context.length > 0)
          event.system.push({ type: 'text', text: output.context.join('\n\n') });
      }),
    ),
  );
  await registerTools(ctx, invoke, registrations);
}

async function handleNativeCompletion(
  runtime: FlowGuardPluginRuntime,
  event: NativeToolCompletion,
): Promise<void> {
  if (event.status === 'error') {
    await reconcileHostMutationEpisodes(runtime, event.sessionID, event.id);
    return;
  }
  if (!record(event.input))
    throw buildEnforcementError(
      'PLUGIN_ENFORCEMENT_UNAVAILABLE',
      'The governed tool completion input is not an object.',
    );
  const content = event.result.content;
  if (content !== undefined && typeof content !== 'string') {
    throw buildEnforcementError(
      'PLUGIN_ENFORCEMENT_UNAVAILABLE',
      'Non-text tool completion cannot be projected without losing native content.',
    );
  }
  const output = { title: '', output: content ?? '', metadata: { ...event.result.metadata } };
  await toolAfter(
    runtime,
    {
      tool: applicationTool(event.tool),
      sessionID: event.sessionID,
      callID: event.id,
      args: event.input,
    },
    output,
  );
  event.result = { ...event.result, content: output.output, metadata: output.metadata };
}

async function registerTools(
  ctx: Plugin.Context,
  invoke: Invoke,
  registrations: Registration[],
): Promise<void> {
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
  registrations.push(
    await ctx.tool.transform((editor) => {
      for (const { name, definition, schema, input } of definitions)
        editor.add({
          name,
          description: definition.description,
          input,
          options: { codemode: false },
          execute: (args, context) =>
            invoke(context.sessionID, async ({ runtime }) =>
              executeTool(name, definition, schema.parse(args), context, runtime),
            ),
        });
    }),
  );
}

async function executeTool(
  name: string,
  definition: ToolDefinition,
  args: unknown,
  context: NativeToolContext,
  runtime: FlowGuardPluginRuntime,
) {
  const authority = await runtime.ws.resolveSessionAuthority(context.sessionID);
  if (authority.status === 'unavailable')
    throw buildEnforcementError(authority.code, authority.reason);
  if (name === TOOL_FLOWGUARD_HYDRATE && authority.status !== 'resolved') {
    throw buildEnforcementError(
      'PLUGIN_ENFORCEMENT_UNAVAILABLE',
      'Hydrate cannot create activation without verified operator UI provenance.',
    );
  }
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

async function consumeEvents(
  ctx: Plugin.Context,
  signal: AbortSignal,
  consume: (event: OpenCodeEvent) => Promise<void>,
  failed: (error: unknown) => void,
  operations: Set<Promise<unknown>>,
): Promise<void> {
  try {
    for await (const event of ctx.event.subscribe({ signal })) {
      // Never make the source await a handler whose host I/O can publish events.
      const operation = consume(event);
      operations.add(operation);
      void operation
        .catch((error) => {
          if (!signal.aborted) failed(error);
        })
        .finally(() => operations.delete(operation));
    }
    if (!signal.aborted)
      failed(
        buildEnforcementError(
          'PLUGIN_ENFORCEMENT_UNAVAILABLE',
          'The V2 event stream ended unexpectedly.',
        ),
      );
  } catch (error) {
    if (!signal.aborted) failed(error);
  }
}

/** Native OpenCode V2 composition. Governance decisions remain in their canonical owners. */
import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { Plugin } from '@opencode/plugin';
import type { OpenCodeEvent } from '@opencode/client';
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
import { encodeHostCallId } from '../state/host-identity.js';
import { createWorkspace } from './plugin-workspace.js';
import { buildEnforcementError } from './blocked-result.js';
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';
import { READ_ONLY_HOST_TOOLS, NATIVE_SUBAGENT_TOOL } from './phase-tool-gate.js';
import { FLOWGUARD_TOOL_NAMES, TOOL_FLOWGUARD_HELP } from './tool-names.js';
import { help } from './tools/index.js';
import {
  createNativeToolCatalogue,
  executeCanonicalNativeTool,
  handleNativeCompletion,
  applicationTool,
  type NativeCanonicalExecutor,
} from './plugin-native-tools.js';
import { OpenCodeGovernance, type ActiveGovernanceScope } from './opencode-governance.js';
import { resolveGovernanceActivation } from '../adapters/governance-activation.js';
import { createNativeReviewerAuthority } from './plugin-native-review.js';
import { createEventFence, consumeEvents } from './plugin-native-events.js';

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
};
type ScopedRuntimeEntry = RuntimeEntry & { readonly scope: ActiveGovernanceScope };

/** This is the only OpenCode entrypoint. There is deliberately no callable V1 factory. */
export const FlowGuardAuditPlugin = Plugin.define({
  id: 'flowguard',
  async setup(ctx) {
    const controller = new AbortController();
    const adapter = new OpenCodeHostAdapter(ctx, controller.signal);
    const registrations: Registration[] = [];
    const runtimes = new Map<string, Promise<RuntimeEntry>>();
    const sessionRoots = new Map<string, string>();
    const reviewer = createNativeReviewerAuthority(ctx, async (scope) => {
      assertAvailable(scope);
      const entry = await loadRuntime(runtimes, sessionRoots, adapter, scope);
      assertAvailable(scope);
      return entry.runtime;
    });
    const governance = new OpenCodeGovernance(ctx, adapter, controller.signal, reviewer);
    const fence = createEventFence(governance, adapter);
    const operations = new Set<Promise<unknown>>();
    let ready = false;
    let closed = false;
    let eventLoop: Promise<void> | undefined;
    let cleanup: Promise<void> | undefined;

    const assertLifecycle = (): void => {
      if (!ready || closed) {
        throw buildEnforcementError(
          'PLUGIN_ENFORCEMENT_UNAVAILABLE',
          'The V2 plugin is not ready or has stopped.',
        );
      }
    };
    const assertAvailable = (scope: ActiveGovernanceScope): void => {
      assertLifecycle();
      fence.assert(scope);
    };
    const actions = createRuntimeActions({
      governance,
      adapter,
      runtimes,
      sessionRoots,
      operations,
      assertLifecycle,
      assertAvailable,
    });

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
      await createFlowGuardPluginHooks(ctx, { ...actions, governance, reviewer }, registrations);
      eventLoop = consumeEvents(
        ctx,
        controller.signal,
        (event) =>
          governance.observeProgress(event) ??
          dispatchEvent(event, runtimes, sessionRoots, actions.invoke, governance),
        fence.failed,
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

type RuntimeActionInput = {
  governance: OpenCodeGovernance;
  adapter: OpenCodeHostAdapter;
  runtimes: Map<string, Promise<RuntimeEntry>>;
  sessionRoots: Map<string, string>;
  operations: Set<Promise<unknown>>;
  assertLifecycle: () => void;
  assertAvailable: (scope: ActiveGovernanceScope) => void;
};

function createRuntimeActions(input: RuntimeActionInput) {
  const {
    governance,
    adapter,
    runtimes,
    sessionRoots,
    operations,
    assertLifecycle,
    assertAvailable,
  } = input;
  const resolveEntry = async (
    sessionId: string,
    required: boolean,
  ): Promise<ScopedRuntimeEntry | null> => {
    assertLifecycle();
    const authority = await governance.resolve(sessionId);
    if (authority.kind === 'blocked') throw buildEnforcementError(authority.code, authority.reason);
    if (authority.kind === 'inactive') {
      if (required)
        throw buildEnforcementError(
          'GOVERNANCE_NOT_ACTIVE',
          'Native host operation is unchanged; this workflow tool cannot establish activation.',
        );
      return null;
    }
    const scope = authority.scope;
    assertAvailable(scope);
    const entry = await loadRuntime(runtimes, sessionRoots, adapter, scope);
    await assertFreshScope(governance, sessionId, scope);
    assertAvailable(scope);
    return { ...entry, scope };
  };
  const invoke: Invoke = async (sessionId, action, required = false) =>
    trackOperation(
      operations,
      (async () => {
        const entry = await resolveEntry(sessionId, required);
        return entry ? action(entry) : undefined;
      })(),
    );
  const execute: NativeCanonicalExecutor = async (name, definition, args, context) =>
    trackOperation(
      operations,
      (async () => {
        const entry = await resolveEntry(context.sessionID, name !== TOOL_FLOWGUARD_HELP);
        if (!entry) return { content: help.description, metadata: {} };
        if (name === TOOL_FLOWGUARD_HELP && entry.scope.sessionId !== entry.scope.root.sessionId)
          return { content: help.description, metadata: {} };
        if (entry.scope.sessionId !== entry.scope.root.sessionId && name !== TOOL_FLOWGUARD_HELP)
          throw buildEnforcementError(
            'GOVERNANCE_AUTHORITY_BLOCKED',
            'Delegated host execution does not authorize parent workflow decisions.',
          );
        return executeCanonicalNativeTool(name, definition, args, context, entry.runtime);
      })(),
    );
  return { invoke, execute, observe: createReadOnlyObserver(input) };
}

function createReadOnlyObserver(input: RuntimeActionInput) {
  const { governance, runtimes, sessionRoots, operations, assertLifecycle, assertAvailable } =
    input;
  return async (event: NativeToolCompletion) => {
    assertLifecycle();
    const authority = await governance.resolve(event.sessionID);
    if (authority.kind === 'blocked') throw buildEnforcementError(authority.code, authority.reason);
    if (authority.kind === 'inactive') return;
    // Positive read-only vocabulary only. Cached runtime is diagnostic context,
    // never state/approval authority; rich native content is never parsed.
    const check = () => assertAvailable(authority.scope);
    check();
    const root = sessionRoots.get(event.sessionID);
    const runtime = root === undefined ? undefined : runtimes.get(root);
    if (event.status !== 'completed' || !runtime) return;
    const callID = encodeHostCallId(event.sessionID, event.messageID, event.id);
    const sessionID = authority.scope.root.sessionId;
    await trackOperation(
      operations,
      runtime.then(async (entry) => {
        check();
        const output = { title: '', output: event.result.content, metadata: event.result.metadata };
        await toolAfter(
          entry.runtime,
          { tool: event.tool, sessionID, callID, args: event.input },
          output,
        );
      }),
    );
  };
}

async function assertFreshScope(
  governance: OpenCodeGovernance,
  sessionId: string,
  scope: ActiveGovernanceScope,
): Promise<void> {
  const fresh = await governance.resolve(sessionId);
  if (
    fresh.kind !== 'active' ||
    fresh.scope.record.revision !== scope.record.revision ||
    fresh.scope.root.revision !== scope.root.revision
  )
    throw buildEnforcementError(
      'GOVERNANCE_AUTHORITY_BLOCKED',
      'Activation changed while loading the governed runtime.',
    );
}

async function trackOperation<T>(
  operations: Set<Promise<unknown>>,
  operation: Promise<T>,
): Promise<T> {
  operations.add(operation);
  try {
    return await operation;
  } finally {
    operations.delete(operation);
  }
}

async function loadRuntime(
  runtimes: Map<string, Promise<RuntimeEntry>>,
  sessionRoots: Map<string, string>,
  adapter: OpenCodeHostAdapter,
  scope: ActiveGovernanceScope,
): Promise<RuntimeEntry> {
  const authority = await resolveSessionAuthority({
    root: scope.root.directory,
    sessionId: scope.root.sessionId,
  });
  if (authority.status === 'unavailable')
    throw buildEnforcementError(authority.code, authority.reason);
  const root = authority.worktreeRoot;
  if (authority.status !== 'resolved')
    throw buildEnforcementError(
      'SESSION_DIR_NOT_FOUND',
      'Cannot verify host tool phase gate because the ACTIVE workflow state is missing.',
      { stateReadable: 'false' },
    );
  if (
    root !== scope.root.worktreeRoot ||
    authority.state.policySnapshot.hash !== scope.root.policyDigest
  )
    throw buildEnforcementError(
      'GOVERNANCE_AUTHORITY_BLOCKED',
      'The workflow no longer matches its activation worktree or frozen policy.',
    );
  sessionRoots.set(scope.sessionId, root);
  let entry = runtimes.get(root);
  if (!entry) {
    entry = createSessionRuntime(adapter, root);
    runtimes.set(root, entry);
    const initializing = entry;
    void initializing.catch(() => {
      if (runtimes.get(root) === initializing) runtimes.delete(root);
    });
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
  if (eventLoop) await eventLoop;
  await Promise.allSettled([...operations]);
  // Prompt preflight can still own an in-flight catalogue publication. Drain
  // it before taking the final registration snapshot, including late handles.
  const registrationsDisposed = await Promise.allSettled(
    registrations.map((registration) => registration.dispose()),
  );
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
  governance: OpenCodeGovernance,
): Promise<void> {
  const projected = projectOpenCodeEvent(event);
  if (!projected) return;
  if (event.type === 'session.deleted') {
    const authority = await resolveGovernanceActivation(governance.store, projected.sessionId);
    if (authority.kind === 'blocked') throw buildEnforcementError(authority.code, authority.reason);
    if (authority.kind !== 'active') return;
    const root = sessionRoots.get(projected.sessionId);
    const entry = root === undefined ? undefined : runtimes.get(root);
    if (entry && authority.record.rootSessionId === projected.sessionId)
      await handlePluginEvent((await entry).runtime, projected.event, projected.sessionId);
    sessionRoots.delete(projected.sessionId);
    return;
  }
  await invoke(projected.sessionId, (entry) =>
    handlePluginEvent(entry.runtime, projected.event, entry.scope.root.sessionId),
  );
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
    // Logging may fall back to defaults; governed execution may not. An
    // unreadable or invalid flowguard.json blocks every ACTIVE operation of this
    // worktree instead of silently running with default policy or reviewer budgets.
    if (configReadError !== undefined)
      throw buildEnforcementError(
        'CONFIG_INVALID',
        `FlowGuard configuration is unreadable or invalid: ${configReadError instanceof Error ? configReadError.message : String(configReadError)}`,
      );
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
      toolLatencyStarts: new Map(),
      activeCommandScopes: new Map(),
      checkReworkContinuations: new Set(),
      reviewerExecutionTimeoutMs: config.reviewer.executionTimeoutMs,
      logError,
    };
    return {
      runtime,
      dispose: async () => {
        await disposeLogging?.();
      },
    };
  } catch (error) {
    await disposeLogging?.();
    throw error;
  }
}

type Invoke = <T>(
  sessionId: string,
  action: (entry: ScopedRuntimeEntry) => Promise<T>,
  required?: boolean,
) => Promise<T | undefined>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function observeReviewerRead(
  actions: {
    readonly reviewer: ReturnType<typeof createNativeReviewerAuthority>;
    readonly observe: (event: NativeToolCompletion) => Promise<void>;
  },
  event: NativeToolCompletion,
) {
  if (event.agent === REVIEWER_SUBAGENT_TYPE) actions.reviewer.afterTool(event);
  return actions.observe(event);
}

/** Register each native hook exactly once; there is no intermediate SDK hook object. */
async function createFlowGuardPluginHooks(
  ctx: Plugin.Context,
  actions: {
    readonly invoke: Invoke;
    readonly execute: NativeCanonicalExecutor;
    readonly governance: OpenCodeGovernance;
    readonly reviewer: ReturnType<typeof createNativeReviewerAuthority>;
    readonly observe: (event: NativeToolCompletion) => Promise<void>;
  },
  registrations: Registration[],
): Promise<void> {
  const { invoke, governance } = actions;
  const catalogue = await createNativeToolCatalogue(ctx, registrations, actions.execute);
  registrations.push(
    await ctx.tool.hook('execute.before', (event) =>
      invoke(
        event.sessionID,
        async ({ runtime, scope }) => {
          await actions.reviewer.beforeTool(scope, event);
          if (!record(event.input))
            throw buildEnforcementError(
              'PLUGIN_ENFORCEMENT_UNAVAILABLE',
              'The governed tool input is not an object.',
            );
          if (
            scope.sessionId !== scope.root.sessionId &&
            FLOWGUARD_TOOL_NAMES.some((name) => name === event.tool && name !== TOOL_FLOWGUARD_HELP)
          )
            throw buildEnforcementError(
              'GOVERNANCE_AUTHORITY_BLOCKED',
              'A native delegation cannot submit parent workflow decisions.',
            );
          const output = { args: event.input };
          await toolBefore(
            runtime,
            {
              tool: applicationTool(event.tool),
              sessionID: scope.root.sessionId,
              callID: encodeHostCallId(event.sessionID, event.messageID, event.id),
            },
            output,
          );
          event.input = output.args;
          if (event.agent === REVIEWER_SUBAGENT_TYPE) actions.reviewer.authorizeTool(event);
          if (event.tool === NATIVE_SUBAGENT_TOOL) await governance.authorizeDispatch(scope, event);
        },
        FLOWGUARD_TOOL_NAMES.some((name) => name === event.tool && name !== TOOL_FLOWGUARD_HELP),
      ),
    ),
  );
  registrations.push(
    await ctx.tool.hook('execute.after', (event) => {
      if (READ_ONLY_HOST_TOOLS.has(event.tool)) return observeReviewerRead(actions, event);
      if (
        event.tool === NATIVE_SUBAGENT_TOOL &&
        record(event.input) &&
        event.input.agent === REVIEWER_SUBAGENT_TYPE
      ) {
        return invoke(event.sessionID, async ({ scope }) => {
          try {
            await actions.reviewer.capture(scope, event);
          } finally {
            governance.quarantineReviewerDispatch(event);
          }
        });
      }
      return invoke(event.sessionID, ({ runtime, scope }) =>
        handleNativeCompletion(runtime, scope.root.sessionId, event),
      );
    }),
  );
  await registerNativeSessionHooks(ctx, invoke, catalogue, registrations, actions.reviewer);
  registrations.push(
    await ctx.session.hook('model.request', (event) =>
      invoke(event.sessionID, ({ scope }) => actions.reviewer.request(scope, event)),
    ),
  );
}

async function registerNativeSessionHooks(
  ctx: Plugin.Context,
  invoke: Invoke,
  catalogue: Awaited<ReturnType<typeof createNativeToolCatalogue>>,
  registrations: Registration[],
  reviewer: ReturnType<typeof createNativeReviewerAuthority>,
): Promise<void> {
  registrations.push(
    await ctx.session.hook('prompt', (event) =>
      invoke(event.sessionID, async ({ scope }) => {
        // Admission is not execution authority. Direct reviewer roots retain
        // budget-first context denial; only enrolled reviewer children may execute.
        if (
          scope.sessionId !== scope.root.sessionId &&
          (await ctx.session.get({ sessionID: event.sessionID })).agent === REVIEWER_SUBAGENT_TYPE
        )
          await reviewer.prompt(scope, event);
        await catalogue.ensurePublished();
      }),
    ),
  );
  registrations.push(
    await ctx.session.hook('context', (event) =>
      invoke(event.sessionID, async (entry) => {
        if (entry.scope.sessionId !== entry.scope.root.sessionId) catalogue.hideProductive(event);
        else if (!catalogue.published) {
          await catalogue.ensurePublished();
          throw buildEnforcementError(
            'GOVERNANCE_AUTHORITY_BLOCKED',
            'The ACTIVE catalogue was not present when this request snapshot was captured; retry the request.',
          );
        }
        if (event.agent === REVIEWER_SUBAGENT_TYPE) await reviewer.context(entry.scope, event);
        return true;
      }).then((active) => {
        if (active !== true) catalogue.hideProductive(event);
      }),
    ),
  );
  registrations.push(
    await ctx.session.hook('compaction', (event) =>
      invoke(event.sessionID, async ({ runtime, scope }) => {
        if (
          (await ctx.session.get({ sessionID: event.sessionID })).agent === REVIEWER_SUBAGENT_TYPE
        )
          throw buildEnforcementError(
            'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
            'Reviewer compaction is not authorized by dispatch.',
          );
        const output = { context: [] as string[] };
        await handleCompaction(runtime, { sessionID: scope.root.sessionId }, output);
        if (output.context.length > 0)
          event.system.push({ type: 'text', text: output.context.join('\n\n') });
        if (scope.sessionId !== scope.root.sessionId) catalogue.hideProductive(event);
        return true;
      }).then((active) => {
        if (active !== true) catalogue.hideProductive(event);
      }),
    ),
  );
  registrations.push(
    await ctx.session.hook('generate', (event) =>
      invoke(event.sessionID, async ({ scope }) => {
        if (
          (await ctx.session.get({ sessionID: event.sessionID })).agent === REVIEWER_SUBAGENT_TYPE
        )
          throw buildEnforcementError(
            'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
            'Transient reviewer generation is not authorized by dispatch.',
          );
        if (scope.sessionId !== scope.root.sessionId) catalogue.hideProductive(event);
        return true;
      }).then((active) => {
        if (active !== true) catalogue.hideProductive(event);
      }),
    ),
  );
}

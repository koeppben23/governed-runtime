import { readState } from '../adapters/persistence.js';
import { withSessionWriteLock } from '../adapters/persistence-lock.js';
import { completeMutationEpisode } from '../state/evidence-mutation-episode.js';
import { strictBlockedOutput } from './blocked-result.js';

import type { ToolHookAfterInput, ToolHookAfterOutput } from './types.js';
import type { FlowGuardPluginRuntime } from './plugin-shared.js';
import { writeStateWithAuditOperationsAlreadyLocked } from './audit-outbox.js';
import { MUTATING_HOST_TOOLS } from './phase-tool-gate.js';
import { validateBinding, validateFingerprintBinding } from '../adapters/binding.js';
import type { SessionAuthorityResolution } from '../adapters/session-authority.js';
import type { MutationEpisode } from '../state/evidence-mutation-episode.js';
import { getRuntimeInstanceId } from './runtime-instance.js';
import { acquireRuntimeLease } from './runtime-lease.js';
import { IntegrationInvariantError } from './errors.js';

class MutationCompletionLeaseError extends IntegrationInvariantError {
  constructor(readonly activeLeaseGeneration: number) {
    super(
      'MUTATION_EPISODE_LEASE_UNAVAILABLE',
      'Another live runtime holds the mutation completion lease.',
    );
  }
}

/**
 * A mutating host tool is governed by the Before-hook boundary: no host call
 * reaches execution without a resolvable session directory, readable state, and
 * an authorized mutation episode. The After-hook therefore treats missing
 * governed context as an invariant violation and blocks instead of silently
 * skipping completion.
 */
function blockUnavailableCompletion(output: ToolHookAfterOutput, reason: string): void {
  output.output = strictBlockedOutput('PLUGIN_ENFORCEMENT_UNAVAILABLE', { reason });
}

export async function recordMutationCompletion(input: {
  readonly runtime: FlowGuardPluginRuntime;
  readonly sessionId: string;
  readonly hookInput: ToolHookAfterInput;
  readonly hookOutput: ToolHookAfterOutput;
  readonly now: string;
}): Promise<void> {
  const { runtime, sessionId, hookInput, hookOutput, now } = input;
  if (!MUTATING_HOST_TOOLS.has(hookInput.tool)) return;
  const callId = hookInput.callID;
  if (!callId) {
    blockUnavailableCompletion(
      hookOutput,
      'The completed mutating host tool has no host callID; its authorized mutation episode cannot be closed.',
    );
    return;
  }
  const resolution = await runtime.ws.resolveSessionAuthority(sessionId);
  if (resolution.status !== 'resolved') {
    blockUnavailableCompletion(
      hookOutput,
      'The completed mutating host tool has no resolvable FlowGuard session directory; its authorized mutation episode cannot be closed.',
    );
    return;
  }
  const expected = resolution.state.mutationEpisodes.find(
    (episode) => episode.hostCallId === callId && episode.toolName === hookInput.tool,
  );
  if (!expected) {
    blockUnavailableCompletion(
      hookOutput,
      'No authorized mutation episode exists for this host call; the mutation is not acknowledged as governed.',
    );
    return;
  }
  try {
    await commitMutationCompletion({
      resolution,
      expected,
      now,
      outcome: mutationOutcome(hookInput.tool, hookOutput),
      sessionId,
    });
  } catch (error) {
    if (!(error instanceof IntegrationInvariantError)) throw error;
    hookOutput.output = strictBlockedOutput(error.code, {
      reason: error.message,
      ...(error instanceof MutationCompletionLeaseError
        ? { activeLeaseGeneration: String(error.activeLeaseGeneration) }
        : {}),
    });
  }
}

/** Single completion writer for After, event-triggered reads, and pre-implement reconciliation. */
export async function commitMutationCompletion(input: {
  readonly resolution: Extract<SessionAuthorityResolution, { status: 'resolved' }>;
  readonly expected: MutationEpisode;
  readonly sessionId: string;
  readonly now: string;
  readonly outcome: 'success' | 'failure' | 'unknown';
}): Promise<'completed' | 'unchanged'> {
  const { resolution, expected, sessionId, now, outcome } = input;
  const sessDir = resolution.sessDir;
  return withSessionWriteLock(sessDir, async () => {
    const state = await readState(sessDir);
    if (!state)
      throw new IntegrationInvariantError(
        'PLUGIN_ENFORCEMENT_UNAVAILABLE',
        'FlowGuard session state disappeared before the mutation episode could be completed.',
      );
    validateBinding(state, { worktreeRoot: resolution.worktreeRoot, sessionId });
    validateFingerprintBinding(state, resolution.fingerprint);
    if (state.binding.hostSessionId !== sessionId)
      throw new IntegrationInvariantError(
        'SESSION_BINDING_MISMATCH',
        'The mutation completion belongs to another host session.',
      );
    if (state.flowguardSessionId !== resolution.state.flowguardSessionId)
      throw new IntegrationInvariantError(
        'PLUGIN_ENFORCEMENT_UNAVAILABLE',
        'The FlowGuard session changed before mutation completion.',
      );
    const episode = state.mutationEpisodes.find(
      (candidate) => candidate.hostCallId === expected.hostCallId,
    );
    if (!episode || !sameDispatch(episode, expected))
      throw new IntegrationInvariantError(
        'PLUGIN_ENFORCEMENT_UNAVAILABLE',
        'The authorized mutation dispatch changed before completion.',
      );
    if (
      state.mutationEpisodeResolutions.some((item) => item.hostCallId === episode.hostCallId) ||
      episode.status === 'completed'
    )
      return 'unchanged';
    const acquisition = acquireRuntimeLease({
      current: state.runtimeLease,
      runtimeInstanceId: getRuntimeInstanceId(),
      pid: process.pid,
      now: new Date().toISOString(),
    });
    if (acquisition.kind === 'blocked')
      throw new MutationCompletionLeaseError(acquisition.lease.generation);
    if (!state.runtimeLease || !validLeaseProvenance(episode, acquisition.lease))
      throw new IntegrationInvariantError(
        'PLUGIN_ENFORCEMENT_UNAVAILABLE',
        'Mutation authorization does not match the runtime lease provenance.',
      );
    await writeStateWithAuditOperationsAlreadyLocked(sessDir, {
      ...state,
      runtimeLease: acquisition.lease,
      mutationEpisodes: completeMutationEpisode(
        state.mutationEpisodes,
        episode.hostCallId,
        episode.toolName,
        now,
        outcome,
      ),
    });
    return 'completed';
  });
}

function validLeaseProvenance(
  episode: MutationEpisode,
  lease: { generation: number; holderRuntimeInstanceId: string },
): boolean {
  return (
    episode.leaseGeneration < lease.generation ||
    (episode.leaseGeneration === lease.generation &&
      episode.runtimeInstanceId === lease.holderRuntimeInstanceId)
  );
}

function sameDispatch(current: MutationEpisode, expected: MutationEpisode): boolean {
  return (
    current.episodeId === expected.episodeId &&
    current.toolName === expected.toolName &&
    current.runtimeInstanceId === expected.runtimeInstanceId &&
    current.leaseGeneration === expected.leaseGeneration &&
    current.authorizedAt === expected.authorizedAt
  );
}

/**
 * Best-effort outcome classification from the pinned OpenCode hook contract.
 *
 * The After-hook carries no normative, typed success/failure authority:
 * `metadata` and `output` are host-owned and not a contractual verdict
 * signal. Explicit error signals classify `failure`; explicit success
 * signals classify `success`; anything else is `unknown`. All three are
 * retained without assuming absence of filesystem changes. Observed failure
 * can bind to a fresh implementation digest; unknown remains ineligible and
 * requires the existing fenced unknown-outcome recovery.
 */
function mutationOutcome(
  toolName: string,
  hookOutput: ToolHookAfterOutput,
): 'success' | 'failure' | 'unknown' {
  if (hookOutput.metadata.error === true) return 'failure';
  const bashOutcome = bashExitOutcome(toolName, hookOutput.metadata.exit);
  if (bashOutcome) return bashOutcome;
  const parsed = parseStructuredOutcome(hookOutput.output);
  if (parsed?.error === true) return 'failure';
  if (hookOutput.metadata.success === true || parsed?.success === true) return 'success';
  if (toolName === 'apply_patch' && Array.isArray(hookOutput.metadata.files)) return 'success';
  if (isWriteSuccess(toolName, hookOutput.metadata)) return 'success';
  if (isEditSuccess(toolName, hookOutput.metadata)) return 'success';
  return 'unknown';
}

function bashExitOutcome(toolName: string, exit: unknown): 'success' | 'failure' | null {
  if (toolName !== 'bash' || typeof exit !== 'number') return null;
  return exit === 0 ? 'success' : 'failure';
}

/** OpenCode WriteTool success contract: filepath, prior existence, and diagnostics. */
function isWriteSuccess(toolName: string, metadata: Record<string, unknown>): boolean {
  return (
    toolName === 'write' &&
    typeof metadata.filepath === 'string' &&
    typeof metadata.exists === 'boolean' &&
    isRecord(metadata.diagnostics)
  );
}

/** OpenCode EditTool success contract: both diffs and diagnostics are emitted. */
function isEditSuccess(toolName: string, metadata: Record<string, unknown>): boolean {
  return (
    toolName === 'edit' &&
    typeof metadata.diff === 'string' &&
    isFileDiff(metadata.filediff) &&
    isRecord(metadata.diagnostics)
  );
}

function isFileDiff(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.file === 'string' &&
    typeof value.patch === 'string' &&
    typeof value.additions === 'number' &&
    typeof value.deletions === 'number'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStructuredOutcome(output: string): Record<string, unknown> | null {
  try {
    return JSON.parse(output) as Record<string, unknown>;
  } catch {
    return null;
  }
}

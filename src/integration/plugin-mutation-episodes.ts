import { readState } from '../adapters/persistence.js';
import { withSessionWriteLock } from '../adapters/persistence-lock.js';
import { completeMutationEpisode } from '../state/evidence-mutation-episode.js';
import { strictBlockedOutput } from './blocked-result.js';

import type { ToolHookAfterInput, ToolHookAfterOutput } from './types.js';
import type { FlowGuardPluginRuntime } from './plugin-shared.js';
import { writeStateWithAuditOperationsAlreadyLocked } from './audit-outbox.js';
import { MUTATING_HOST_TOOLS } from './phase-tool-gate.js';

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
  const sessDir = runtime.ws.getSessionDir(sessionId);
  if (!sessDir) {
    blockUnavailableCompletion(
      hookOutput,
      'The completed mutating host tool has no resolvable FlowGuard session directory; its authorized mutation episode cannot be closed.',
    );
    return;
  }
  await withSessionWriteLock(sessDir, async () => {
    const state = await readState(sessDir);
    if (!state) {
      blockUnavailableCompletion(
        hookOutput,
        'FlowGuard session state disappeared before the mutation episode could be completed.',
      );
      return;
    }
    const episode = state.mutationEpisodes.find(
      (candidate) => candidate.hostCallId === callId && candidate.toolName === hookInput.tool,
    );
    if (!episode) {
      blockUnavailableCompletion(
        hookOutput,
        'No authorized mutation episode exists for this host call; the mutation is not acknowledged as governed.',
      );
      return;
    }
    // A fenced recovery makes a prior host outcome permanently unobservable.
    // Ignore a delayed After hook instead of invalidating the append-only resolution.
    if (
      state.mutationEpisodeResolutions.some(
        (resolution) => resolution.hostCallId === episode.hostCallId,
      )
    )
      return;
    await writeStateWithAuditOperationsAlreadyLocked(sessDir, {
      ...state,
      mutationEpisodes: completeMutationEpisode(
        state.mutationEpisodes,
        callId,
        hookInput.tool,
        now,
        mutationOutcome(hookInput.tool, hookOutput),
      ),
    });
  });
}

/**
 * Best-effort outcome classification from the pinned OpenCode hook contract.
 *
 * The After-hook carries no normative, typed success/failure authority:
 * `metadata` and `output` are host-owned and not a contractual verdict
 * signal. Explicit error signals classify `failure`; explicit success
 * signals classify `success`; anything else is `unknown`. All three are
 * bound by the reconciliation — a host call that failed may still have
 * mutated files, so binding never depends on this classification.
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

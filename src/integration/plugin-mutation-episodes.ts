import { readState } from '../adapters/persistence.js';
import { withSessionWriteLock } from '../adapters/persistence-lock.js';
import { completeMutationEpisode } from '../state/evidence-mutation-episode.js';
import type { ToolHookAfterInput, ToolHookAfterOutput } from './types.js';
import type { FlowGuardPluginRuntime } from './plugin-shared.js';
import { writeStateWithAuditOperationsAlreadyLocked } from './tools/audit-outbox.js';
import { MUTATING_HOST_TOOLS } from './phase-tool-gate.js';

export async function recordMutationCompletion(input: {
  readonly runtime: FlowGuardPluginRuntime;
  readonly sessionId: string;
  readonly hookInput: ToolHookAfterInput;
  readonly hookOutput: ToolHookAfterOutput;
  readonly now: string;
}): Promise<void> {
  const { runtime, sessionId, hookInput, hookOutput, now } = input;
  if (!MUTATING_HOST_TOOLS.has(hookInput.tool) || !hookInput.callID) return;
  const sessDir = runtime.ws.getSessionDir(sessionId);
  if (!sessDir) return;
  await withSessionWriteLock(sessDir, async () => {
    const state = await readState(sessDir);
    const episode = state?.mutationEpisodes.find(
      (candidate) =>
        candidate.hostCallId === hookInput.callID && candidate.toolName === hookInput.tool,
    );
    if (!state || !episode) return;
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
        hookInput.callID,
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
    Array.isArray(metadata.diagnostics)
  );
}

/** OpenCode EditTool success contract: both diffs and diagnostics are emitted. */
function isEditSuccess(toolName: string, metadata: Record<string, unknown>): boolean {
  return (
    toolName === 'edit' &&
    typeof metadata.diff === 'string' &&
    metadata.filediff !== undefined &&
    Array.isArray(metadata.diagnostics)
  );
}

function parseStructuredOutcome(output: string): Record<string, unknown> | null {
  try {
    return JSON.parse(output) as Record<string, unknown>;
  } catch {
    return null;
  }
}

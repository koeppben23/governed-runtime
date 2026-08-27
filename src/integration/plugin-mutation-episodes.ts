import { readState } from '../adapters/persistence.js';
import { withSessionWriteLock } from '../adapters/persistence-lock.js';
import { completeMutationEpisode } from '../state/evidence-mutation-episode.js';
import type { ToolHookAfterInput, ToolHookAfterOutput } from './types.js';
import type { FlowGuardPluginRuntime } from './plugin-shared.js';
import { writeStateWithAuditOperationsAlreadyLocked } from './tools/audit-outbox.js';

const MUTATING_HOST_TOOLS = new Set(['bash', 'write', 'edit', 'apply_patch']);

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
    if (!state?.mutationEpisodes.some((episode) => episode.hostCallId === hookInput.callID)) return;
    await writeStateWithAuditOperationsAlreadyLocked(sessDir, {
      ...state,
      mutationEpisodes: completeMutationEpisode(
        state.mutationEpisodes,
        hookInput.callID,
        now,
        mutationOutcome(hookOutput),
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
function mutationOutcome(hookOutput: ToolHookAfterOutput): 'success' | 'failure' | 'unknown' {
  if (hookOutput.metadata.error === true) return 'failure';
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(hookOutput.output) as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  if (parsed?.error === true) return 'failure';
  if (hookOutput.metadata.success === true || parsed?.success === true) return 'success';
  return 'unknown';
}

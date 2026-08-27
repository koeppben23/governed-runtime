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

function mutationOutcome(hookOutput: ToolHookAfterOutput): 'success' | 'failure' {
  if (hookOutput.metadata.error === true) return 'failure';
  try {
    return JSON.parse(hookOutput.output).error === true ? 'failure' : 'success';
  } catch {
    return 'success';
  }
}

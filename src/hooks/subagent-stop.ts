#!/usr/bin/env node
/**
 * @module hooks/subagent-stop
 * @description FlowGuard SubagentStop command hook — reviewer corroboration capture.
 *
 * Invoked by Claude Code when a subagent finishes. When the subagent is the
 * `flowguard-reviewer`, this hook records an independent host-captured corroboration
 * record (an out-of-band witness that the reviewer subagent ran). This record is later
 * read at review-evidence construction time to upgrade `manual_attested` review evidence
 * to `native_subagent_attested`.
 *
 * SubagentStop hooks are informational here — they never block subagent completion and
 * always exit 0. A non-reviewer subagent, or any failure, simply writes no capture
 * (fail-closed: no capture means no tier upgrade).
 *
 * @version v1
 */

import { readStdin, validateSubagentStopPayload } from './shared/stdin-reader.js';
import { writeLog } from './shared/stdout-writer.js';
import { installHookStdoutGuard } from './shared/stdout-guard.js';
import { resolveSession } from './shared/session-resolver.js';
import { detectPlatform } from './shared/platform-detect.js';
import { writeReviewerCapture } from './shared/reviewer-capture-writer.js';

async function main(): Promise<void> {
  const guard = installHookStdoutGuard();
  try {
    await subagentStopLogic();
  } finally {
    guard.restore();
  }
}

async function subagentStopLogic(): Promise<void> {
  let payload: Record<string, unknown>;
  try {
    payload = await readStdin();
  } catch (err) {
    writeLog(`stdin read failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const platform = detectPlatform(payload);
  writeLog(`subagent-stop platform: ${platform}`);

  let validated: ReturnType<typeof validateSubagentStopPayload>;
  try {
    validated = validateSubagentStopPayload(payload);
  } catch (err) {
    writeLog(`validation failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const { session_id, cwd, agent_id, agent_type } = validated;

  const resolution = await resolveSession(cwd, session_id);
  if (!resolution.ok) {
    writeLog(`INFO: session state not available (${resolution.code}) — skip capture`);
    return;
  }

  await writeReviewerCapture(
    resolution.sessionDir,
    {
      source: 'subagent_stop_hook',
      sessionId: session_id,
      agentId: agent_id,
      agentType: agent_type,
    },
    writeLog,
  );
}

main().catch((err: unknown) => {
  writeLog(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  // SubagentStop is never blocking — always exit 0.
  process.exitCode = 0;
});

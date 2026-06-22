/**
 * @module cli/doctor-handshake
 * @description Session handshake check for the doctor command.
 *
 * Extracted from doctor-command.ts to keep the module under the 700 LOC
 * threshold. Checks whether the last session has a pending review
 * obligation without a plugin handshake — a sign that enforcement
 * hooks are not active.
 *
 * @version v1
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DoctorCheck, InstallScope } from './install-types.js';

async function checkObligationHandshake(
  pointer: { sessionId: string; worktree: string },
  pointerPath: string,
  checks: DoctorCheck[],
): Promise<void> {
  const { computeFingerprint } = await import('../adapters/workspace/fingerprint.js');
  const { sessionDir } = await import('../adapters/workspace/init.js');
  const fp = await computeFingerprint(pointer.worktree);
  const sessDir = sessionDir(fp.fingerprint, pointer.sessionId);

  if (!existsSync(join(sessDir, 'session-state.json'))) {
    checks.push({
      file: pointerPath,
      status: 'warn',
      detail: 'Session state file not found — cannot verify handshake',
    });
    return;
  }

  const stateRaw = readFileSync(join(sessDir, 'session-state.json'), 'utf-8');
  const state = JSON.parse(stateRaw) as Record<string, unknown>;
  const assurance = state.reviewAssurance as
    | { obligations?: Array<{ status?: string; pluginHandshakeAt?: unknown }> }
    | undefined;

  const pendingObligation = assurance?.obligations?.find((o) => o.status === 'pending');
  if (!pendingObligation) return;

  if (pendingObligation.pluginHandshakeAt == null) {
    checks.push({
      file: pointerPath,
      status: 'error',
      detail:
        'Pending review obligation without plugin handshake — plugin enforcement hooks are not active. Restart OpenCode and verify flowguard-audit plugin loads.',
    });
  } else {
    checks.push({
      file: pointerPath,
      status: 'ok',
      detail: 'Last session plugin handshake present',
    });
  }
}

export async function checkLastSessionHandshake(scope: InstallScope): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  if (scope !== 'global') return checks;

  const pointerPath = join(
    process.env.OPENCODE_CONFIG_DIR || join(homedir(), '.config', 'opencode'),
    'SESSION_POINTER.json',
  );

  try {
    const raw = readFileSync(pointerPath, 'utf-8');
    const pointer = JSON.parse(raw) as { sessionId?: string; worktree?: string };
    if (!pointer.sessionId || !pointer.worktree) {
      checks.push({
        file: pointerPath,
        status: 'warn',
        detail: 'SESSION_POINTER.json missing sessionId or worktree — cannot verify handshake',
      });
      return checks;
    }
    await checkObligationHandshake(
      pointer as { sessionId: string; worktree: string },
      pointerPath,
      checks,
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      checks.push({
        file: pointerPath,
        status: 'warn',
        detail:
          'Cannot check session handshake: ' + (err instanceof Error ? err.message : String(err)),
      });
    }
  }

  return checks;
}

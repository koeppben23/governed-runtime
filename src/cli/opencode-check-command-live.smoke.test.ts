/** A real native check on the pinned host with an explicitly seeded validation gate. */
import { execFileSync } from 'node:child_process';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertNativeCommandWitness } from '../../demos/java-task-manager/live-native-command-witness.mjs';
import { readAuditTrail } from '../adapters/persistence-audit.js';
import { resolveSessionAuthority } from '../adapters/session-authority.js';
import { makeProgressedState } from '../fixtures.js';
import { withTestEnv } from '../integration/test-helpers.js';
import { writeStateWithArtifacts } from '../integration/tools/helpers.js';
import { createNativeHostProbe } from './opencode-native-test-helpers.js';

const LIVE = process.env.OPENCODE_LIVE === '1' || process.env.FLOWGUARD_OPENCODE_HOST_E2E === '1';

describe.skipIf(!LIVE)('native /check command on the pinned host', () => {
  it('executes a real check and witnesses its persisted baseline attempt', async () => {
    let nextTool: 'flowguard_status' | 'flowguard_run_check' | undefined;
    const host = await createNativeHostProbe({
      product: true,
      script: () => {
        const name = nextTool;
        nextTool = undefined;
        if (!name) return { text: 'Done.' };
        return {
          tool: {
            name,
            arguments: name === 'flowguard_run_check' ? { kind: 'test' } : { compact: true },
          },
        };
      },
      async prepare(project) {
        await writeFile(join(project, '.gitignore'), 'executed\nobserver.jsonl\n');
        await writeFile(
          join(project, 'check.cjs'),
          "require('node:fs').writeFileSync('executed', 'native check executed\\n', { flag: 'wx' });",
        );
        await writeFile(
          join(project, 'package.json'),
          JSON.stringify({
            name: 'native-check',
            version: '1.0.0',
            scripts: { test: 'node check.cjs' },
          }),
        );
        execFileSync('git', ['add', '.'], { cwd: project });
        execFileSync(
          'git',
          [
            '-c',
            'user.name=Native Check',
            '-c',
            'user.email=check@example.test',
            'commit',
            '-qm',
            'Fixture',
          ],
          { cwd: project },
        );
      },
    });
    const restore = withTestEnv({ OPENCODE_CONFIG_DIR: host.env.OPENCODE_CONFIG_DIR! });
    try {
      const { id: sessionId } = await host.session();
      const worktree = await realpath(host.project);
      const persisted = async () => {
        const result = await resolveSessionAuthority({ root: worktree, sessionId });
        if (result.status !== 'resolved') throw new Error(`Unbound native check: ${result.status}`);
        return result;
      };
      const wait = () =>
        host.client.session.wait(
          { sessionID: sessionId },
          { signal: AbortSignal.timeout(120_000) },
        );
      await host.client.session.command({ sessionID: sessionId, name: 'start', text: '' });
      await wait();
      const bound = await persisted();
      const gate = makeProgressedState('VALIDATION');
      // Arrange the gate only. Check execution, result persistence and audit must be native.
      await writeStateWithArtifacts(bound.sessDir, {
        ...bound.state,
        phase: gate.phase,
        ticket: gate.ticket,
        plan: gate.plan,
        selfReview: gate.selfReview,
        reviewDecision: gate.reviewDecision,
        activeChecks: ['test'],
      });
      // Reconcile the fixture write before taking the pre-dispatch snapshot.
      nextTool = 'flowguard_status';
      await host.prompt(sessionId, 'Read the current validation status.');
      const before = (await persisted()).state;
      expect(before.validationAttempts).toEqual([]);
      const auditBefore = await readAuditTrail(bound.sessDir);
      nextTool = 'flowguard_run_check';
      const startedAt = Date.now();
      await host.client.session.command({ sessionID: sessionId, name: 'check', text: '' });
      await wait();
      const completedAt = Date.now();
      const after = (await persisted()).state;
      expect(await readFile(join(host.project, 'executed'), 'utf8')).toBe(
        'native check executed\n',
      );
      expect(after.validationAttempts).toEqual([
        expect.objectContaining({
          scope: 'baseline',
          planDigest: before.plan!.current.digest,
          result: expect.objectContaining({ checkId: 'test', passed: true, exitCode: 0 }),
        }),
      ]);
      const events = await readAuditTrail(bound.sessDir);
      const window = assertNativeCommandWitness({
        command: 'check',
        before,
        after,
        auditBefore,
        events,
        sessionId,
        startedAt,
        completedAt,
      });
      expect(
        window.some((event: { event: string }) => event.event === 'tool_call:flowguard_run_check'),
      ).toBe(true);
    } finally {
      try {
        await host.close();
      } finally {
        restore();
      }
    }
  }, 300_000);
});

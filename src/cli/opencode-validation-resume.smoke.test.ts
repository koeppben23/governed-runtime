/** Real product retry on the pinned native host, with an explicit component review gate.
 * The gate fixture is NOT reviewer/operator provenance or installed-product acceptance. */
import { execFileSync } from 'node:child_process';
import { readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeHostProbe, type NativeHostProbe } from './opencode-native-test-helpers.js';
import { withTestEnv } from '../integration/test-helpers.js';
import { resolveSessionAuthority } from '../adapters/session-authority.js';
import { writeStateWithArtifacts } from '../integration/tools/helpers.js';
import { makeProgressedState } from '../fixtures.js';
import type { OpenCodeEvent, SessionInfo } from '@opencode/client';

const LIVE = process.env.OPENCODE_LIVE === '1' || process.env.FLOWGUARD_OPENCODE_HOST_E2E === '1';
let probe: NativeHostProbe | undefined;
let restore: (() => void) | undefined;
afterEach(async () => {
  try {
    await probe?.close();
  } finally {
    restore?.();
    probe = undefined;
    restore = undefined;
  }
});
async function workflow(host: NativeHostProbe, sessionID: string) {
  const bound = await resolveSessionAuthority({
    root: await realpath(host.project),
    sessionId: sessionID,
  });
  if (bound.status !== 'resolved') throw new Error(JSON.stringify(bound));
  return bound;
}

describe.skipIf(!LIVE)('native automatic-validation lifecycle', () => {
  it('persists a technical interruption and resumes only the open check on native success', async () => {
    let recordImplementation = false;
    const host = await createNativeHostProbe({
      product: true,
      plugin: `export default Plugin.define({ id: 'resume-observer', async setup(ctx) {
        const { appendFileSync } = await import('node:fs');
        const controller = new AbortController();
        const observing = (async () => { for await (const event of ctx.event.subscribe({ types: ['session.execution.succeeded', 'session.idle'], signal: controller.signal })) {
          const session = await ctx.session.get({ sessionID: event.data.sessionID });
          appendFileSync(ctx.location.directory + '/observer.jsonl', JSON.stringify({ event, session }) + '\\n');
        } })();
        void observing.catch(error => { if (!controller.signal.aborted) appendFileSync(ctx.location.directory + '/observer.jsonl', JSON.stringify({ error: String(error) }) + '\\n'); });
        return async () => { controller.abort(); await observing.catch(() => {}); };
      } });`,
      flowguardConfig: JSON.stringify({ schemaVersion: 'v1', policy: { defaultMode: 'team' } }),
      script: () => {
        if (!recordImplementation) return { text: 'Done.' };
        recordImplementation = false;
        return { tool: { name: 'flowguard_implement', arguments: {} } };
      },
      async prepare(project) {
        await writeFile(
          join(project, '.gitignore'),
          'executions.jsonl\nrecovered\nobserver.jsonl\n',
        );
        await writeFile(join(project, 'README.md'), '# Native validation retry\n');
        await writeFile(
          join(project, 'check.cjs'),
          `
const fs = require('node:fs');
const kind = process.argv[2];
fs.appendFileSync('executions.jsonl', JSON.stringify({ kind }) + '\\n');
process.exit(kind === 'lint' && !fs.existsSync('recovered') ? 127 : 0);
`,
        );
        await writeFile(
          join(project, 'package.json'),
          JSON.stringify({
            name: 'native-validation-resume',
            version: '1.0.0',
            scripts: { test: 'node check.cjs test', lint: 'node check.cjs lint' },
          }),
        );
        execFileSync('git', ['add', '.'], { cwd: project });
        execFileSync(
          'git',
          [
            '-c',
            'user.name=Retry Test',
            '-c',
            'user.email=retry@example.test',
            'commit',
            '--quiet',
            '-m',
            'Retry fixture',
          ],
          { cwd: project },
        );
      },
    });
    probe = host;
    restore = withTestEnv({ OPENCODE_CONFIG_DIR: host.env.OPENCODE_CONFIG_DIR! });
    const root = await host.session();
    await host.client.session.command({ sessionID: root.id, name: 'start', text: '' });
    const bound = await workflow(host, root.id);
    const gate = makeProgressedState('PLAN_REVIEW');
    await writeStateWithArtifacts(bound.sessDir, {
      ...bound.state,
      phase: gate.phase,
      ticket: gate.ticket,
      plan: gate.plan,
      selfReview: gate.selfReview,
      reviewAssurance: gate.reviewAssurance,
      activeChecks: ['test', 'lint'],
    });
    await host.client.session.command({
      sessionID: root.id,
      name: 'approve',
      text: 'Component-reviewed retry fixture.',
    });
    await host.client.session.wait({ sessionID: root.id }, { signal: AbortSignal.timeout(30_000) });
    const interrupted = (await workflow(host, root.id)).state;
    expect(interrupted.phase).toBe('VALIDATION');
    expect(interrupted.pendingSystemWork).toMatchObject({ kind: 'validation', attempt: 1 });
    expect(
      interrupted.validationAttempts.map((attempt) => attempt.result.exitCode),
      JSON.stringify(interrupted.validationAttempts),
    ).toEqual([0, 127]);
    expect(
      interrupted.validationAttempts.every(
        (attempt) =>
          attempt.scope === 'baseline' && attempt.planDigest === interrupted.plan!.current.digest,
      ),
    ).toBe(true);
    expect(interrupted.reviewDecision?.verdict).toBe('approve');
    const marker = interrupted.pendingSystemWork!;
    expect(marker.retryAfter).not.toBeNull();
    await host.prompt(root.id, 'An ordinary completion inside retry backoff; no tools.');
    expect((await workflow(host, root.id)).state.validationAttempts).toEqual(
      interrupted.validationAttempts,
    );
    expect((await workflow(host, root.id)).state.pendingSystemWork).toEqual(marker);
    await writeFile(join(host.project, 'recovered'), 'available');
    // No fabricated retry state or check evidence: wait for the persisted backoff.
    await vi.waitFor(
      () => expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(marker.retryAfter!)),
      { timeout: 15_000 },
    );
    const sibling = await host.session();
    await host.prompt(sibling.id, 'An unrelated native session must not resume the root.');
    expect((await workflow(host, root.id)).state.validationAttempts).toEqual(
      interrupted.validationAttempts,
    );
    await host.prompt(root.id, 'Complete an ordinary native turn; do not run any tools.');
    await vi.waitFor(
      async () =>
        expect(
          (await workflow(host, root.id)).state.phase,
          host.output() + JSON.stringify(await host.entries()),
        ).toBe('IMPLEMENTATION'),
      { timeout: 20_000 },
    );
    const resumed = (await workflow(host, root.id)).state;
    expect(resumed.pendingSystemWork).toBeNull();
    expect(
      resumed.validationAttempts.map((attempt) => [attempt.result.kind, attempt.result.exitCode]),
    ).toEqual([
      ['test', 0],
      ['lint', 127],
      ['lint', 0],
    ]);
    expect(resumed.validationAttempts[0]).toEqual(interrupted.validationAttempts[0]);
    expect(
      (await readFile(join(host.project, 'executions.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual([{ kind: 'test' }, { kind: 'lint' }, { kind: 'lint' }]);
    await writeFile(
      join(host.project, 'README.md'),
      '# Native validation retry\n\nImplementation change.\n',
    );
    await unlink(join(host.project, 'recovered'));
    recordImplementation = true;
    await host.prompt(root.id, 'Record the implementation with flowguard_implement.');
    const implInterrupted = (await workflow(host, root.id)).state;
    expect(
      implInterrupted.phase,
      JSON.stringify(await host.client.session.context({ sessionID: root.id })),
    ).toBe('IMPL_VALIDATION');
    expect(implInterrupted.pendingSystemWork).toMatchObject({ kind: 'validation', attempt: 1 });
    const presentation = async () => {
      const result = await host.client.rpc.call({
        location: host.location,
        rpcID: 'flowguard-governance',
        method: 'GetPresentation',
        input: { sessionID: root.id },
      });
      return (result.output as { events: Array<{ phase: string; message: string }> }).events;
    };
    expect((await presentation()).some((event) => event.phase === 'IMPL_VALIDATION')).toBe(false);
    expect(
      implInterrupted.validationAttempts
        .slice(3)
        .map((attempt) => [attempt.scope, attempt.result.kind, attempt.result.exitCode]),
    ).toEqual([
      ['implementation', 'test', 0],
      ['implementation', 'lint', 127],
    ]);
    const implMarker = implInterrupted.pendingSystemWork!;
    await writeFile(join(host.project, 'recovered'), 'available');
    await vi.waitFor(
      () => expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(implMarker.retryAfter!)),
      { timeout: 15_000 },
    );
    await host.prompt(root.id, 'Complete the second ordinary native wakeup without tools.');
    await vi.waitFor(
      async () => {
        const state = (await workflow(host, root.id)).state;
        expect(
          state.phase,
          host.output() +
            JSON.stringify({
              marker: state.pendingSystemWork,
              attempts: state.validationAttempts,
              events: await host.entries(),
            }),
        ).toBe('IMPL_REVIEW');
      },
      { timeout: 20_000 },
    );
    const implResumed = (await workflow(host, root.id)).state;
    expect(implResumed.pendingSystemWork).toBeNull();
    expect((await presentation()).some((event) => event.phase === 'IMPL_VALIDATION')).toBe(false);
    expect(
      implResumed.validationAttempts
        .slice(3)
        .map((attempt) => [attempt.scope, attempt.result.kind, attempt.result.exitCode]),
    ).toEqual([
      ['implementation', 'test', 0],
      ['implementation', 'lint', 127],
      ['implementation', 'lint', 0],
    ]);
    expect(implResumed.validationAttempts.slice(0, 5)).toEqual(implInterrupted.validationAttempts);
    for (const attempt of implResumed.validationAttempts.slice(3)) {
      expect(attempt).toMatchObject({
        implementationId: implInterrupted.implementation!.implementationId,
        implementationDigest: implInterrupted.implementation!.digest,
      });
    }
    const observations = await host.entries<{
      event: Exclude<OpenCodeEvent, { type: 'server.connected' }>;
      session: SessionInfo;
    }>();
    const successes = observations.filter(
      (entry) =>
        entry.event.type === 'session.execution.succeeded' &&
        entry.event.data.sessionID === root.id,
    );
    expect(successes.length).toBeGreaterThanOrEqual(2);
    const eligible = successes.filter(
      ({ event, session }) =>
        session.id === root.id &&
        session.outcome === 'succeeded' &&
        session.time.idle === event.created &&
        session.time.busy !== undefined &&
        session.time.busy <= event.created,
    );
    expect(eligible.some(({ event }) => event.created >= Date.parse(marker.retryAfter!))).toBe(
      true,
    );
    expect(eligible.some(({ event }) => event.created >= Date.parse(implMarker.retryAfter!))).toBe(
      true,
    );
    expect(observations.some((entry) => entry.event.type === 'session.idle')).toBe(false);
    expect(host.errors).toEqual([]);
  }, 180_000);
});

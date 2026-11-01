import { spawnSync } from 'node:child_process';
import { readFile, realpath, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMutationHostProbe } from './opencode-mutation-test-helpers.js';
import { makeProgressedState } from '../fixtures.js';
import { computeFingerprint, sessionDir } from '../adapters/workspace/index.js';
import { writeStateWithArtifacts } from '../integration/tools/helpers.js';
import { readState } from '../adapters/persistence.js';
import { computeGitControlPlaneMarker } from '../integration/git-control-plane.js';
import { nativeHostCallId } from '../integration/opencode-host-adapter.js';

const LIVE = process.env.OPENCODE_LIVE === '1' || process.env.FLOWGUARD_OPENCODE_HOST_E2E === '1';

describe.skipIf(!LIVE)('OpenCode mutation lifecycle (real pinned host)', () => {
  let probe: Awaited<ReturnType<typeof createMutationHostProbe>>;
  beforeAll(async () => {
    probe = await createMutationHostProbe();
  }, 180_000);
  afterAll(async () => {
    await probe?.close();
  });

  it('pins the executable version', () => {
    const result = spawnSync(probe.host.command, [...probe.host.argsPrefix, '--version'], {
      env: probe.env,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(probe.host.version);
  });

  it('a real throwing edit emits native error observations for the exact call', async () => {
    const file = join(probe.project, 'edit-target.txt');
    await writeFile(file, 'original\n');
    const session = await probe.session();
    await probe.prompt(session, [
      {
        name: 'edit',
        args: {
          path: file,
          oldString: 'absent text',
          newString: 'replacement',
        },
      },
    ]);
    const entries = (await probe.entries()).filter(
      (entry) =>
        entry.input?.sessionID === session ||
        (entry.event && 'sessionID' in entry.event.data && entry.event.data.sessionID === session),
    );
    const before = entries.find(
      (entry) => entry.hook === 'execute.before' && entry.input?.tool === 'edit',
    );
    expect(before).toBeDefined();
    expect(
      entries.find(
        (entry) => entry.hook === 'execute.after' && entry.input?.id === before?.input?.id,
      ),
      JSON.stringify(entries),
    ).toMatchObject({ input: { status: 'error' } });
    await vi.waitFor(async () => {
      expect(
        (await probe.entries()).some(
          (entry) =>
            entry.event?.type === 'session.tool.failed' &&
            entry.event.data.sessionID === session &&
            entry.event.data.id === before?.input?.id,
        ),
      ).toBe(true);
    });
    const history = await probe.history(session);
    const terminal = history
      .flatMap((message) => (message.type === 'assistant' ? message.content : []))
      .find((part) => part.type === 'tool' && part.id === before?.input?.id);
    expect(terminal).toMatchObject({
      type: 'tool',
      name: 'edit',
      executed: false,
      state: { status: 'error', error: { type: 'tool.execution' } },
      time: {
        created: expect.any(Number),
        ran: expect.any(Number),
        completed: expect.any(Number),
      },
    });
    expect(history.at(-1)).toMatchObject({ type: 'idle', outcome: 'succeeded' });
    expect(await readFile(file, 'utf8')).toBe('original\n');
  });

  it('native interruption is distinct from successful execution with a regular tool error', async () => {
    const session = await probe.session();
    const prompt = probe.prompt(session, [{ name: 'probe_wait', args: {} }]);
    await vi.waitFor(
      async () => {
        expect(
          (await probe.entries()).some(
            (entry) =>
              entry.hook === 'execute.before' &&
              entry.input?.sessionID === session &&
              entry.input.tool === 'probe_wait',
          ),
        ).toBe(true);
      },
      { timeout: 30_000 },
    );
    expect(
      await probe.client.session.interrupt({ sessionID: session, resume: false }),
    ).toMatchObject({ interrupted: true });
    await prompt;
    await vi.waitFor(
      async () => {
        const history = await probe.history(session);
        expect(history.at(-1), JSON.stringify(history)).toMatchObject({
          type: 'idle',
          outcome: 'interrupted',
        });
        const interruptedTool = history
          .flatMap((message) => (message.type === 'assistant' ? message.content : []))
          .find((part) => part.type === 'tool' && part.name === 'probe_wait');
        expect(interruptedTool).toMatchObject({
          executed: false,
          state: { status: 'error', error: { type: 'aborted' } },
        });
        expect(
          (await probe.entries()).some(
            (entry) =>
              entry.event?.type === 'session.execution.interrupted' &&
              entry.event.data.sessionID === session,
          ),
        ).toBe(true);
      },
      { timeout: 30_000 },
    );
  });

  it.skipIf(process.platform === 'win32').each([0, 7])(
    'shell exit %i does not prove descendant quiescence',
    async (exit) => {
      const prefix = join(probe.root, `writer-${exit}`);
      const writer = `${prefix}.cjs`;
      await writeFile(
        writer,
        `const fs = require('node:fs');
process.on('SIGTERM', () => {});
fs.writeFileSync(${JSON.stringify(`${prefix}.pid`)}, String(process.pid));
const timer = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(`${prefix}.release`)})) {
    fs.writeFileSync(${JSON.stringify(`${prefix}.changed`)}, 'late mutation');
    clearInterval(timer);
  }
}, 10);
setTimeout(() => process.exit(2), 45000).unref();\n`,
      );
      const session = await probe.session();
      try {
        await probe.prompt(session, [
          {
            name: 'shell',
            args: {
              command: `"${process.execPath}" "${writer}" </dev/null >/dev/null 2>&1 & while [ ! -f "${prefix}.pid" ]; do sleep 0.01; done; exit ${exit}`,
              description: 'Controlled descendant-quiescence probe',
              timeout: 10_000,
            },
          },
        ]);
        const entries = await probe.entries();
        expect(
          entries.some(
            (entry) =>
              entry.hook === 'execute.after' &&
              entry.input?.sessionID === session &&
              entry.input.tool === 'shell',
          ),
        ).toBe(true);
        const pid = Number(await readFile(`${prefix}.pid`, 'utf8'));
        expect(() => process.kill(pid, 0)).not.toThrow();
        await writeFile(`${prefix}.release`, 'release');
        await vi.waitFor(
          async () => {
            expect(await readFile(`${prefix}.changed`, 'utf8')).toBe('late mutation');
          },
          { timeout: 10_000 },
        );
      } finally {
        await stopWriter(prefix);
      }
    },
  );
});

async function stopWriter(prefix: string): Promise<void> {
  try {
    process.kill(Number(await readFile(`${prefix}.pid`, 'utf8')), 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

describe.skipIf(!LIVE)('MUT4 real-host FlowGuard recovery', () => {
  let probe: Awaited<ReturnType<typeof createMutationHostProbe>>;
  beforeAll(async () => {
    probe = await createMutationHostProbe(true);
  }, 180_000);
  afterAll(async () => {
    await probe?.close();
  });

  it('records an actual delegated child edit failure in the root without changing its native identity', async () => {
    const session = await probe.session();
    const file = join(probe.project, 'edit-target.txt');
    await writeFile(file, 'pending delegated implementation\n');
    const previousConfig = process.env.OPENCODE_CONFIG_DIR;
    process.env.OPENCODE_CONFIG_DIR = probe.env.OPENCODE_CONFIG_DIR;
    try {
      const root = await realpath(probe.project);
      const fingerprint = await computeFingerprint(root);
      const stateDir = sessionDir(fingerprint.fingerprint, session);
      const state = makeProgressedState('IMPLEMENTATION');
      await writeStateWithArtifacts(stateDir, {
        ...state,
        binding: {
          ...state.binding,
          hostSessionId: session,
          worktree: root,
          fingerprint: fingerprint.fingerprint,
        },
        implementationBaseline: {
          capturedAt: new Date().toISOString(),
          dirtyFiles: [],
          controlPlaneMarker: await computeGitControlPlaneMarker(root),
        },
      });
      await probe.client.rpc.call({
        location: probe.location,
        rpcID: 'flowguard-component-activation',
        method: 'seed',
        input: { sessionID: session, policyDigest: state.policySnapshot.hash, worktreeRoot: root },
      });
      const requestStart = probe.requests.length;
      await probe.prompt(session, [
        {
          name: 'subagent',
          args: {
            agent: 'general',
            description: 'Bounded edit-error probe',
            prompt: 'Attempt the requested edit.',
          },
        },
        { name: 'edit', args: { path: file, oldString: 'absent', newString: 'new' } },
      ]);
      const childRequest = probe.requests
        .slice(requestStart)
        .find((request) => request.sessionID !== session);
      expect(childRequest).toBeDefined();
      const childID = childRequest!.sessionID;
      const history = await probe.history(childID);
      const message = history.find(
        (entry) =>
          entry.type === 'assistant' &&
          entry.content.some((part) => part.type === 'tool' && part.name === 'edit'),
      );
      const part =
        message?.type === 'assistant'
          ? message.content.find((entry) => entry.type === 'tool' && entry.name === 'edit')
          : undefined;
      expect(part, JSON.stringify(history)).toMatchObject({
        type: 'tool',
        state: { status: 'error', error: { type: 'tool.execution' } },
      });
      if (message?.type !== 'assistant' || part?.type !== 'tool')
        throw new Error('Missing native child edit');
      await vi.waitFor(async () => {
        expect((await readState(stateDir))!.mutationEpisodes).toEqual([
          expect.objectContaining({
            hostCallId: nativeHostCallId(childID, message.id, part.id),
            status: 'completed',
            outcome: 'failure',
          }),
        ]);
      });
      await probe.prompt(session, [{ name: 'flowguard_implement', args: {} }]);
      expect(
        (await readState(stateDir))!.implementation?.changedFiles,
        JSON.stringify(await probe.history(session)),
      ).toContain('edit-target.txt');
      expect(await readFile(file, 'utf8')).toBe('pending delegated implementation\n');
    } finally {
      if (previousConfig === undefined) delete process.env.OPENCODE_CONFIG_DIR;
      else process.env.OPENCODE_CONFIG_DIR = previousConfig;
    }
  }, 120_000);

  it.each(['event', 'synchronous barrier after plugin reload'])(
    'recovers an actual throwing edit via %s',
    async (channel) => {
      const session = await probe.session();
      const file = join(probe.project, 'edit-target.txt');
      await writeFile(file, `pending implementation ${channel}\n`);
      const previousConfig = process.env.OPENCODE_CONFIG_DIR;
      process.env.OPENCODE_CONFIG_DIR = probe.env.OPENCODE_CONFIG_DIR;
      let stateDir: string;
      try {
        const root = await realpath(probe.project);
        const fingerprint = await computeFingerprint(root);
        stateDir = sessionDir(fingerprint.fingerprint, session);
        const state = makeProgressedState('IMPLEMENTATION');
        const bound = {
          ...state,
          binding: {
            ...state.binding,
            hostSessionId: session,
            worktree: root,
            fingerprint: fingerprint.fingerprint,
          },
          implementationBaseline: {
            capturedAt: new Date().toISOString(),
            dirtyFiles: [],
            controlPlaneMarker: await computeGitControlPlaneMarker(root),
          },
        };
        await writeStateWithArtifacts(stateDir, bound);
        // Explicit component authority around the real product hooks; this is
        // neither UI-origin evidence nor acceptance of Finding 5.
        await probe.client.rpc.call({
          location: probe.location,
          rpcID: 'flowguard-component-activation',
          method: 'seed',
          input: {
            sessionID: session,
            policyDigest: bound.policySnapshot.hash,
            worktreeRoot: root,
          },
        });
        if (channel !== 'event')
          await writeFile(
            join(probe.project, '.fixture-drop-mutation-completion'),
            'fault injection',
          );
        await probe.prompt(session, [
          { name: 'edit', args: { path: file, oldString: 'absent', newString: 'new' } },
        ]);
        expect(
          (await readState(stateDir))?.mutationEpisodes.length,
          JSON.stringify({
            stateDir,
            location: await probe.entries(),
            history: await probe.history(session),
          }),
        ).toBe(1);
        if (channel === 'event') {
          await vi.waitFor(
            async () => {
              expect((await readState(stateDir))?.mutationEpisodes[0]).toMatchObject({
                status: 'completed',
                outcome: 'failure',
              });
            },
            { timeout: 30_000 },
          );
        } else {
          await vi.waitFor(async () => {
            const entries = await probe.entries();
            expect(
              entries.some(
                (entry) =>
                  entry.hook === 'component.dropped-after' && entry.input?.sessionID === session,
              ),
            ).toBe(true);
            expect(
              entries.some(
                (entry) =>
                  entry.hook === 'component.dropped-event' &&
                  entry.event?.type === 'session.tool.failed' &&
                  entry.event.data.sessionID === session,
              ),
            ).toBe(true);
          });
          await probe.client.location.reload({ signal: AbortSignal.timeout(60_000) });
          await probe.client.agent.list({ location: probe.location });
          await rm(join(probe.project, '.fixture-drop-mutation-completion'));
          expect((await readState(stateDir))?.mutationEpisodes[0]?.status).toBe(
            'dispatch_authorized',
          );
          await probe.prompt(session, [{ name: 'flowguard_status', args: { whyBlocked: true } }]);
          const history = await probe.history(session);
          const statusPart = history
            .flatMap((message) => (message.type === 'assistant' ? message.content : []))
            .find((part) => part.type === 'tool' && part.name === 'flowguard_status');
          const text =
            statusPart?.type === 'tool' && statusPart.state.status === 'completed'
              ? statusPart.state.content
                  .filter((part) => part.type === 'text')
                  .map((part) => part.text)
                  .join('')
              : '{}';
          const status = JSON.parse(text) as {
            whyBlocked?: { blocked?: boolean; reasonCode?: string };
          };
          expect(status.whyBlocked).toMatchObject({
            blocked: true,
            reasonCode: 'MUTATION_EPISODE_UNRESOLVED',
          });
        }
        await probe.prompt(session, [{ name: 'flowguard_implement', args: {} }]);
        const after = (await readState(stateDir))!;
        expect(
          after.mutationEpisodes[0],
          JSON.stringify(await probe.history(session)),
        ).toMatchObject({
          status: 'completed',
          outcome: 'failure',
        });
        expect(after.mutationEpisodeResolutions).toEqual([]);
        expect(
          after.implementation?.changedFiles,
          JSON.stringify(await probe.history(session)),
        ).toContain('edit-target.txt');
      } finally {
        await rm(join(probe.project, '.fixture-drop-mutation-completion'), { force: true });
        if (previousConfig === undefined) delete process.env.OPENCODE_CONFIG_DIR;
        else process.env.OPENCODE_CONFIG_DIR = previousConfig;
      }
    },
  );
});

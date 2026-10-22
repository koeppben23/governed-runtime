import { spawnSync } from 'node:child_process';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMutationHostProbe } from './opencode-mutation-test-helpers.js';
import { makeProgressedState } from '../fixtures.js';
import { computeFingerprint, sessionDir } from '../adapters/workspace/index.js';
import { writeStateWithArtifacts } from '../integration/tools/helpers.js';
import { readState } from '../adapters/persistence.js';
import { computeGitControlPlaneMarker } from '../integration/git-control-plane.js';

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

  it('a real throwing edit skips After and emits an exact regular error part', async () => {
    const file = join(probe.project, 'edit-target.txt');
    await writeFile(file, 'original\n');
    const session = await probe.session();
    await probe.prompt(session, [
      {
        name: 'edit',
        args: {
          filePath: file,
          oldString: 'absent text',
          newString: 'replacement',
        },
      },
    ]);
    const entries = (await probe.entries()).filter(
      (entry) =>
        entry.input?.sessionID === session || entry.event?.properties.part?.sessionID === session,
    );
    const before = entries.find((entry) => entry.hook === 'before' && entry.input?.tool === 'edit');
    expect(before).toBeDefined();
    expect(
      entries.some(
        (entry) => entry.hook === 'after' && entry.input?.callID === before?.input?.callID,
      ),
    ).toBe(false);
    const parts = entries.flatMap((entry) => entry.event?.properties.part ?? []);
    const terminal = parts.find(
      (part) => part.callID === before?.input?.callID && part.state.status === 'error',
    );
    expect(terminal).toMatchObject({ type: 'tool', tool: 'edit', sessionID: session });
    expect(terminal!.state.metadata?.interrupted).not.toBe(true);
    expect(terminal!.state.time?.end).toBeTypeOf('number');
    expect(await readFile(file, 'utf8')).toBe('original\n');
  });

  it('host cleanup marks an unfinished tool as interrupted even with an end date', async () => {
    const session = await probe.session();
    const prompt = probe.prompt(session, [{ name: 'probe_wait', args: {} }]);
    await vi.waitFor(
      async () => {
        expect(
          (await probe.entries()).some(
            (entry) =>
              entry.hook === 'before' &&
              entry.input?.sessionID === session &&
              entry.input.tool === 'probe_wait',
          ),
        ).toBe(true);
      },
      { timeout: 30_000 },
    );
    await probe.request(`/session/${session}/abort`, {});
    await prompt;
    await vi.waitFor(
      async () => {
        const parts = (await probe.entries()).flatMap(
          (entry) => entry.event?.properties.part ?? [],
        );
        expect(
          parts.find(
            (part) =>
              part.sessionID === session &&
              part.tool === 'probe_wait' &&
              part.state.status === 'error',
          ),
        ).toMatchObject({
          state: { metadata: { interrupted: true }, time: { end: expect.any(Number) } },
        });
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
            name: 'bash',
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
              entry.hook === 'after' &&
              entry.input?.sessionID === session &&
              entry.input.tool === 'bash',
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

  it.each(['event', 'synchronous barrier'])(
    'recovers an actual throwing edit via %s',
    async (channel) => {
      const session = await probe.session();
      const file = join(probe.project, 'edit-target.txt');
      await writeFile(file, `pending implementation ${channel}\n`);
      if (channel === 'synchronous barrier') await writeFile(probe.dropEvents, 'drop');
      const previousConfig = process.env.OPENCODE_CONFIG_DIR;
      process.env.OPENCODE_CONFIG_DIR = probe.env.OPENCODE_CONFIG_DIR;
      let stateDir: string;
      try {
        const root = await realpath(probe.project);
        const fingerprint = await computeFingerprint(root);
        stateDir = sessionDir(fingerprint.fingerprint, session);
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
        await probe.prompt(session, [
          { name: 'edit', args: { filePath: file, oldString: 'absent', newString: 'new' } },
        ]);
        expect(
          (await readState(stateDir))?.mutationEpisodes.length,
          JSON.stringify({
            stateDir,
            location: await probe.entries(),
            history: await probe.request(`/session/${session}/message`),
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
          expect((await readState(stateDir))?.mutationEpisodes[0]?.status).toBe(
            'dispatch_authorized',
          );
          await probe.prompt(session, [{ name: 'flowguard_status', args: { whyBlocked: true } }]);
          const history = (await probe.request(`/session/${session}/message`)) as Array<{
            parts: Array<{ tool?: string; state: { output?: string } }>;
          }>;
          const statusPart = history
            .flatMap((message) => message.parts)
            .find((part) => part.tool === 'flowguard_status');
          const status = JSON.parse(statusPart?.state.output ?? '{}') as {
            whyBlocked?: { blocked?: boolean; reasonCode?: string };
          };
          expect(status.whyBlocked).toMatchObject({
            blocked: true,
            reasonCode: 'MUTATION_EPISODE_UNRESOLVED',
          });
        }
        await probe.prompt(session, [{ name: 'flowguard_implement', args: {} }]);
        const after = (await readState(stateDir))!;
        expect(after.mutationEpisodes[0]).toMatchObject({
          status: 'completed',
          outcome: 'failure',
        });
        expect(after.mutationEpisodeResolutions).toEqual([]);
        expect(
          after.implementation?.changedFiles,
          JSON.stringify(await probe.request(`/session/${session}/message`)),
        ).toContain('edit-target.txt');
      } finally {
        if (previousConfig === undefined) delete process.env.OPENCODE_CONFIG_DIR;
        else process.env.OPENCODE_CONFIG_DIR = previousConfig;
      }
    },
  );
});

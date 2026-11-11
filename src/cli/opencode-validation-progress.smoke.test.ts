/** AP A only: native transport probes, NOT automatic-validation or installed-product acceptance. */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Rpc } from '@opencode/plugin/rpc';
import type { OpenCodeEvent } from '@opencode/client';
import { projectOpenCodeEvent } from '../integration/opencode-host-adapter.js';
import { createNativeHostProbe, type NativeHostProbe } from './opencode-native-test-helpers.js';
import {
  PROGRESS_PROBE_PTY,
  PROGRESS_PROBE_RPC,
  PROGRESS_PROBE_SERVER,
  progressProbeTui,
} from './opencode-validation-progress-test-helpers.js';

const LIVE = process.env.OPENCODE_LIVE === '1' || process.env.FLOWGUARD_OPENCODE_HOST_E2E === '1';
const Contract = Rpc.define(PROGRESS_PROBE_RPC);
const ANSI_CSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
interface Snapshot {
  runID: string;
  sessionID: string;
  phase: string;
  source: string;
  status: string;
}
let probe: NativeHostProbe | undefined;
let ui: ChildProcess | undefined;
let output = '';

async function retainEvidence(host: NativeHostProbe): Promise<void> {
  const directory = process.env.FLOWGUARD_PROGRESS_PROBE_REPORT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${basename(host.root)}.json`),
    JSON.stringify(
      {
        scope: 'test-fixture transport only; not product validation acceptance',
        reportedVersion: host.reportedVersion,
        providerRequests: host.requests.map((request) => ({ sessionID: request.sessionID })),
        providerErrors: host.errors,
        observations: await host.entries(),
        uiObservations: await readFile(join(host.project, 'ui-progress.jsonl'), 'utf8'),
        terminalOutput: output,
      },
      null,
      2,
    ) + '\n',
  );
}

async function stopUi(): Promise<void> {
  if (!ui || ui.exitCode !== null || ui.signalCode !== null) return;
  const child = ui;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}
afterEach(async () => {
  try {
    if (probe) await retainEvidence(probe);
  } finally {
    try {
      await stopUi();
    } finally {
      ui = undefined;
      await probe?.close();
      probe = undefined;
    }
  }
});

function get(host: NativeHostProbe, sessionID: string): Promise<Snapshot | null> {
  return host.client
    .rpc(Contract)
    .Get({ sessionID }, { location: host.location }) as Promise<Snapshot | null>;
}

async function pending(host: NativeHostProbe, sessionID: string): Promise<Snapshot> {
  let snapshot: Snapshot | null = null;
  await vi.waitFor(
    async () => {
      snapshot = await get(host, sessionID);
      expect(snapshot?.status, host.output() + JSON.stringify(await host.entries())).toBe(
        'pending',
      );
    },
    { timeout: 30_000 },
  );
  if (!snapshot) throw new Error('No pending fixture snapshot');
  return snapshot;
}

async function release(host: NativeHostProbe, snapshot: Snapshot): Promise<void> {
  await writeFile(join(host.project, `release-${snapshot.runID}`), 'release');
}

async function expectNoFixtureErrors(host: NativeHostProbe): Promise<void> {
  expect(host.errors).toEqual([]);
  expect(
    (await host.entries<{ type: string }>()).filter((entry) => entry.type === 'error'),
  ).toEqual([]);
  const uiRecords = (await readFile(join(host.project, 'ui-progress.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string });
  expect(uiRecords.filter((entry) => entry.type === 'error')).toEqual([]);
}

async function startUi(host: NativeHostProbe, sessionID: string): Promise<void> {
  const baseUrl = host.output().match(/listening on\s+(https?:\/\/\S+)/)?.[1];
  if (!baseUrl) throw new Error('Missing private host URL');
  output = '';
  ui = spawn(
    'python3',
    [
      '-c',
      PROGRESS_PROBE_PTY,
      host.host.command,
      ...host.host.argsPrefix,
      '--server',
      baseUrl,
      '--session',
      sessionID,
      host.project,
    ],
    {
      cwd: host.project,
      env: {
        ...host.env,
        OPENCODE_PASSWORD: 'native-test',
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const capture = (chunk: Buffer) => {
    output = (output + String(chunk)).slice(-200_000);
  };
  ui.stdout?.on('data', capture);
  ui.stderr?.on('data', capture);
  let error: Error | undefined;
  ui.once('error', (value) => {
    error = value;
  });
  await vi.waitFor(
    async () => {
      expect(error, output).toBeUndefined();
      expect(ui?.exitCode, output).toBeNull();
      expect(
        await readFile(join(host.project, 'ui-progress.jsonl'), 'utf8'),
        output.replace(ANSI_CSI, '').slice(-6000) + host.output(),
      ).toContain('"type":"ready"');
    },
    { timeout: 30_000 },
  );
}

async function create(
  options: Parameters<typeof createNativeHostProbe>[0] = {},
): Promise<NativeHostProbe> {
  output = '';
  probe = await createNativeHostProbe({
    ...options,
    plugin: PROGRESS_PROBE_SERVER,
    async prepare(project) {
      await writeFile(join(project, 'ui-progress.jsonl'), '');
      await writeFile(
        join(project, '.opencode/plugins/00-observer/tui.ts'),
        progressProbeTui(project),
      );
    },
  });
  return probe;
}

describe.skipIf(!LIVE)('validation progress transport gate (fixture only)', () => {
  it('native ToolContext.progress reaches the pending tool and event stream before completion without an extra prompt', async () => {
    let invoked = false;
    const host = await create({
      script: () => {
        if (invoked) return { text: 'Fixture complete.' };
        invoked = true;
        return { tool: { name: 'flowguard_progress_probe', arguments: {} } };
      },
    });
    const session = await host.session();
    const sibling = await host.session();
    const controller = new AbortController();
    const events: unknown[] = [];
    const observing = (async () => {
      for await (const event of host.client.event.subscribe({
        types: ['session.tool.progress'],
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
      }))
        events.push(event);
    })();
    void observing.catch(() => {});
    let settled = false;
    const running = host.prompt(session.id).finally(() => {
      settled = true;
    });
    void running.catch(() => {});
    let snapshot: Snapshot | undefined;
    try {
      snapshot = await pending(host, session.id);
      await vi.waitFor(
        () =>
          expect(events).toContainEqual(
            expect.objectContaining({
              type: 'session.tool.progress',
              data: expect.objectContaining({
                sessionID: session.id,
                metadata: expect.objectContaining({ runID: snapshot?.runID }),
              }),
            }),
          ),
        { timeout: 15_000 },
      );
      const history = await host.client.session.context({ sessionID: session.id });
      const tools = history.flatMap((message) =>
        message.type === 'assistant' ? message.content.filter((part) => part.type === 'tool') : [],
      );
      // Progress is a transient event, not persisted result metadata. The
      // pending native call still exists independently of the transport event.
      expect(tools).toContainEqual(
        expect.objectContaining({ state: expect.objectContaining({ status: 'running' }) }),
      );
      expect(settled).toBe(false);
      expect(host.requests).toHaveLength(1);
      expect(history.filter((message) => message.type === 'user')).toHaveLength(1);
      expect(await get(host, sibling.id)).toBeNull();
    } finally {
      if (snapshot) await release(host, snapshot);
      await running;
      controller.abort();
      await observing.catch(() => {});
    }
    expect(host.requests).toHaveLength(2); // ordinary tool-result continuation, not a progress prompt
    expect(
      (await host.client.session.context({ sessionID: session.id })).filter(
        (message) => message.type === 'user',
      ),
    ).toHaveLength(1);
    await expectNoFixtureErrors(host);
  }, 120_000);

  describe.skipIf(process.platform === 'win32')('actual POSIX TUI snapshot observer', () => {
    it.each(['VALIDATION', 'IMPL_VALIDATION'])(
      'renders a native command %s snapshot while the command is still pending, with zero model calls',
      async (phase) => {
        const host = await create();
        const session = await host.session();
        const sibling = await host.session();
        await startUi(host, session.id);
        let settled = false;
        const running = host.client.session
          .command({ sessionID: session.id, name: 'progress-probe', text: phase })
          .finally(() => {
            settled = true;
          });
        void running.catch(() => {});
        let snapshot: Snapshot | undefined;
        try {
          snapshot = await pending(host, session.id);
          await vi.waitFor(
            async () =>
              expect(
                output.replace(ANSI_CSI, ''),
                '\nUI: ' +
                  (await readFile(join(host.project, 'ui-progress.jsonl'), 'utf8')) +
                  '\nSERVER: ' +
                  JSON.stringify(await host.entries()).slice(-8000),
              ).toContain(`FG RPC ${phase} pending`),
            {
              timeout: 30_000,
            },
          );
          expect(snapshot).toMatchObject({ source: 'command', phase });
          expect(settled).toBe(false);
          expect(host.requests).toEqual([]);
          expect(await host.client.session.context({ sessionID: session.id })).toEqual([]);
          expect(await get(host, sibling.id)).toBeNull();
          await stopUi(); // the rendering consumer may disappear; command execution still completes
        } finally {
          if (snapshot) await release(host, snapshot);
          await running;
        }
        expect(await get(host, session.id)).toMatchObject({
          runID: snapshot?.runID,
          status: 'completed',
        });
        expect(host.requests).toEqual([]);
        await expectNoFixtureErrors(host);
      },
      120_000,
    );

    it('NEGATIVE: ordinary execution success is not the existing idle resume route; the full transport gate remains blocked', async () => {
      const host = await create();
      const session = await host.session();
      await startUi(host, session.id);
      await writeFile(join(host.project, `resume-${session.id}`), 'IMPL_VALIDATION');
      await host.prompt(session.id, 'Wake the fixture lifecycle observer.');
      let events: Array<{ type: string; event: OpenCodeEvent }> = [];
      await vi.waitFor(
        async () => {
          events = await host.entries();
          expect(events.some((entry) => entry.event?.type === 'session.execution.succeeded')).toBe(
            true,
          );
        },
        { timeout: 15_000 },
      );
      const success = events.find(
        (entry) => entry.event?.type === 'session.execution.succeeded',
      )?.event;
      if (!success) throw new Error('Missing observed success event');
      expect(projectOpenCodeEvent(success)).toBeNull();
      expect(events.some((entry) => entry.event?.type === 'session.idle')).toBe(false);
      expect(await get(host, session.id)).toBeNull();
      expect(output).not.toContain('FG RPC IMPL_VALIDATION pending');
      expect(
        (await host.client.session.context({ sessionID: session.id })).filter(
          (message) => message.type === 'user',
        ),
      ).toHaveLength(1);
      expect(host.requests).toHaveLength(1);
      await expectNoFixtureErrors(host);
    }, 120_000);
  });
});

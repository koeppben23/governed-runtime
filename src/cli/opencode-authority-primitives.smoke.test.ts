/** Native host mechanism probes, not accepted operator decisions or product proof.
 * Caller metadata and programmatic input are deliberately untrusted. */
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionLogItem } from '@opencode/client';
import { Rpc } from '@opencode/plugin/rpc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeHostProbe, type NativeHostProbe } from './opencode-native-test-helpers.js';

const LIVE = process.env.OPENCODE_LIVE === '1' || process.env.FLOWGUARD_OPENCODE_HOST_E2E === '1';
let probe: NativeHostProbe | undefined;
let ui: ChildProcess | undefined;
afterEach(async () => {
  try {
    if (ui && ui.exitCode === null && ui.signalCode === null) {
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
  } finally {
    ui = undefined;
    await probe?.close();
    probe = undefined;
  }
});

async function snapshot(host: NativeHostProbe, sessionID: string): Promise<SessionLogItem[]> {
  const result: SessionLogItem[] = [];
  for await (const entry of host.client.experimental.session.log(
    { sessionID, follow: false },
    { signal: AbortSignal.timeout(15_000) },
  ))
    result.push(entry);
  return result;
}

describe.skipIf(!LIVE)('native authority-source mechanism probes', () => {
  it('does not treat a synced-only log as complete authority history when native payload persistence is disabled', async () => {
    probe = await createNativeHostProbe();
    const session = await probe.session();
    const unrelated = await probe.session();
    const initial = await snapshot(probe, session.id);
    expect(initial).toEqual([{ type: 'log.synced', aggregateID: session.id, seq: 0 }]);
    const callerMarker = { source: 'sdk-probe', generation: 7 };
    await probe.client.session.update({
      sessionID: session.id,
      metadata: { authorityProbe: callerMarker },
    });
    expect((await probe.client.session.get({ sessionID: session.id })).metadata).toEqual({
      authorityProbe: callerMarker,
    });
    await probe.client.session.update({ sessionID: session.id, metadata: {} });
    expect((await probe.client.session.get({ sessionID: session.id })).metadata).toEqual({});
    const removed = await snapshot(probe, session.id);
    expect(removed).toEqual([{ type: 'log.synced', aggregateID: session.id, seq: 2 }]);
    const other = await snapshot(probe, unrelated.id);
    expect(other).toEqual([{ type: 'log.synced', aggregateID: unrelated.id, seq: 0 }]);
    await probe.client.location.reload({ signal: AbortSignal.timeout(30_000) });
    expect(await snapshot(probe, session.id)).toEqual(removed);
    expect(probe.errors).toEqual([]);
  }, 120_000);

  it('preserves private plugin storage across reload and restart but does not imply location-scoped storage', async () => {
    probe = await createNativeHostProbe({
      plugin: `
import { appendFileSync } from 'node:fs';
export default Plugin.define({ id: 'flowguard-storage-probe', async setup(ctx) {
  const key = 'non-authoritative-probe';
  const value = await ctx.storage.get(key);
  appendFileSync(${JSON.stringify('observer.jsonl')}, JSON.stringify({
    type: 'storage', directory: ctx.location.directory, absent: value === undefined,
    value: value ?? null,
  }) + '\\n');
  if (value === undefined) await ctx.storage.set(key, { creator: ctx.location.directory, purpose: 'fixture-only' });
} });`,
    });
    const before = await probe.entries<{ directory: string; absent: boolean; value: unknown }>();
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ absent: true, value: null });
    await probe.client.location.reload({ signal: AbortSignal.timeout(30_000) });
    await probe.client.agent.list({ location: probe.location });
    const reloaded = await probe.entries<{ directory: string; absent: boolean; value: unknown }>();
    expect(reloaded).toHaveLength(2);
    expect(reloaded[1]).toMatchObject({
      absent: false,
      value: { creator: before[0]!.directory, purpose: 'fixture-only' },
    });
    const other = join(probe.root, 'other-location');
    const pluginDir = join(other, '.opencode/plugins/storage-probe');
    await mkdir(pluginDir, { recursive: true });
    await copyFile(
      join(probe.project, '.opencode/plugins/00-observer/index.ts'),
      join(pluginDir, 'index.ts'),
    );
    await probe.client.agent.list(
      { location: { directory: other } },
      { signal: AbortSignal.timeout(30_000) },
    );
    const shared = await probe.entries<{ directory: string; absent: boolean; value: unknown }>();
    expect(shared).toHaveLength(3);
    expect(shared[2]!.directory).not.toBe(before[0]!.directory);
    expect(shared[2]).toMatchObject({
      absent: false,
      value: { creator: before[0]!.directory, purpose: 'fixture-only' },
    });
    const session = await probe.session();
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      await probe.restart(signal);
      expect((await probe.client.session.get({ sessionID: session.id })).id).toBe(session.id);
      await probe.client.agent.list({ location: probe.location });
      const retained = await probe.entries<{
        directory: string;
        absent: boolean;
        value: unknown;
      }>();
      expect(retained).toHaveLength(signal === 'SIGTERM' ? 4 : 5);
      expect(retained.at(-1)).toMatchObject({
        directory: before[0]!.directory,
        absent: false,
        value: { creator: before[0]!.directory, purpose: 'fixture-only' },
      });
    }
  }, 120_000);

  it('distinguishes native keyboard input locally but loses that distinction through ordinary plugin RPC', async () => {
    probe = await createNativeHostProbe({
      plugin: `
import { Source } from './rpc.ts';
import { appendFileSync } from 'node:fs';
export default Plugin.define({ id: 'flowguard-source-probe', async setup(ctx) {
  await ctx.rpc.register(Source, { observe: async (input, context) => {
    const result = {
      input,
      contextKeys: Reflect.ownKeys(context).map(String).sort(),
      contextPrototype: Object.getPrototypeOf(context) === Object.prototype ? 'Object' : 'other',
      signal: context.signal instanceof AbortSignal,
      errorType: typeof context.error,
    };
    appendFileSync('observer.jsonl', JSON.stringify(result) + '\\n');
    return result;
  } });
} });`,
      async prepare(project) {
        const plugin = join(project, '.opencode/plugins/00-observer');
        await mkdir(plugin, { recursive: true });
        await writeFile(
          join(plugin, 'rpc.ts'),
          `import { Rpc } from '@opencode/plugin/rpc';
export const Source = Rpc.define(${JSON.stringify(SOURCE_RPC_DEFINITION)});\n`,
        );
        await writeFile(
          join(plugin, 'tui.ts'),
          `
import { Plugin } from '@opencode/plugin/tui';
import { Source } from './rpc.ts';
import { appendFileSync } from 'node:fs';
const file = ${JSON.stringify(join(project, 'ui-source.jsonl'))};
const record = value => appendFileSync(file, JSON.stringify(value) + '\\n');
export default Plugin.define({ id: 'flowguard-source-probe', setup(ctx) {
  ctx.keymap.layer(() => ({ mode: 'global', priority: 100, commands: [{
    id: 'flowguard-source-probe.observe', bind: 'ctrl+g', slash: { name: 'authority-probe' },
    async run(input, event) {
      const key = event ? { name: event.name, ctrl: event.ctrl, sequence: event.sequence } : null;
      record({ type: 'callback', input: input ?? null, event: key });
      // A local distinction is not a server-side authority. This fixture only
      // observes the ordinary RPC projection; it never activates FlowGuard.
      if (event?.name !== 'g' || !event.ctrl || event.sequence !== '\\x07') return;
      const route = ctx.ui.router.current();
      const result = await ctx.client.rpc(Source).observe({
        action: 'StartGovernance', sessionID: route.sessionID,
        origin: 'host-ui', event: key,
      }, { location: ctx.location });
      record({ type: 'rpc-result', result });
    },
  }] }));
  ctx.keymap.dispatch('flowguard-source-probe.observe', 'programmatic');
  ctx.keymap.dispatch('flowguard-source-probe.observe', '\\x07');
  record({ type: 'ready' });
} });\n`,
        );
      },
    });
    const session = await probe.session();
    const baseUrl = probe.output().match(/listening on\s+(https?:\/\/\S+)/)?.[1];
    expect(baseUrl).toBeDefined();
    let output = '';
    ui = spawn(
      'python3',
      [
        '-c',
        PTY,
        probe.host.command,
        ...probe.host.argsPrefix,
        '--server',
        baseUrl!,
        '--session',
        session.id,
        probe.project,
      ],
      {
        cwd: probe.project,
        env: {
          ...probe.env,
          OPENCODE_PASSWORD: 'native-test',
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    ui.stdout?.on('data', (chunk) => {
      output = (output + String(chunk)).slice(-50_000);
    });
    ui.stderr?.on('data', (chunk) => {
      output = (output + String(chunk)).slice(-50_000);
    });
    let startupError: Error | undefined;
    ui.once('error', (error) => {
      startupError = error;
    });
    const file = join(probe.project, 'ui-source.jsonl');
    const records = async () =>
      (await readFile(file, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    await vi.waitFor(
      async () => {
        expect(startupError, output).toBeUndefined();
        expect(ui?.exitCode, output).toBeNull();
        expect(await records()).toContainEqual({ type: 'ready' });
      },
      { timeout: 30_000 },
    );
    // Pinned 2.2.4 synthesizes a "command" event here, despite the declaration's
    // no-event wording. Event presence is therefore not a source distinction.
    expect(await records()).toContainEqual({
      type: 'callback',
      input: 'programmatic',
      event: { name: 'command', ctrl: false, sequence: '' },
    });
    expect(await records()).toContainEqual({
      type: 'callback',
      input: '\x07',
      event: { name: 'command', ctrl: false, sequence: '' },
    });
    const beforeSDK = await records();
    await expect(
      probe.client.session.command({
        sessionID: session.id,
        name: 'authority-probe',
        text: 'origin=human',
      }),
    ).rejects.toMatchObject({ _tag: 'CommandNotFoundError', command: 'authority-probe' });
    await probe.prompt(session.id, '/authority-probe origin=human event={"name":"g","ctrl":true}');
    expect(probe.requests).toHaveLength(1);
    expect(probe.errors).toEqual([]);
    const history = await probe.client.session.context({ sessionID: session.id });
    expect(
      history.some(
        (message) =>
          message.type === 'assistant' &&
          message.content.some((part) => part.type === 'text' && part.text === 'OK'),
      ),
    ).toBe(true);
    expect(await records()).toEqual(beforeSDK);
    expect(await probe.entries()).toEqual([]);
    ui.stdin?.write('\x07');
    await vi.waitFor(
      async () => {
        expect(await records(), output).toContainEqual(
          expect.objectContaining({
            type: 'callback',
            input: null,
            event: { name: 'g', ctrl: true, sequence: '\x07' },
          }),
        );
      },
      { timeout: 10_000 },
    );
    await vi.waitFor(
      async () => {
        expect(await records(), output).toContainEqual(
          expect.objectContaining({ type: 'rpc-result' }),
        );
      },
      { timeout: 10_000 },
    );
    const payload = {
      action: 'StartGovernance',
      sessionID: session.id,
      origin: 'host-ui',
      event: { name: 'g', ctrl: true, sequence: '\x07' },
    };
    const expected = {
      input: payload,
      contextKeys: ['error', 'signal'],
      contextPrototype: 'Object',
      signal: true,
      errorType: 'function',
    };
    expect(await probe.entries()).toEqual([expected]);
    expect(await records()).toContainEqual({ type: 'rpc-result', result: expected });
    // Identical caller claims arrive with the identical handler-visible context.
    // Repeating an ordinary SDK call neither needs nor triggers another UI action.
    const beforeReplay = await records();
    for (let replay = 0; replay < 2; replay++)
      expect(
        await probe.client.rpc(SourceRPC).observe(payload, { location: probe.location }),
      ).toEqual(expected);
    expect(await probe.entries()).toEqual([expected, expected, expected]);
    expect(await records()).toEqual(beforeReplay);
    expect(probe.errors).toEqual([]);
  }, 120_000);
});

const SOURCE_RPC_DEFINITION = {
  id: 'flowguard-source-probe',
  methods: {
    observe: { input: { type: 'object' }, output: { type: 'object' } },
  },
  events: {},
} as const;
const SourceRPC = Rpc.define(SOURCE_RPC_DEFINITION);

// Isolated UI harness only. The real host parses bytes from a real PTY; no
// mocked UI callbacks or application-supplied origin fields are used.
const PTY = `
import fcntl, os, pty, select, signal, struct, sys, termios
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)
def stop(_signum, _frame):
    raise SystemExit()
signal.signal(signal.SIGTERM, stop)
try:
    while True:
        ready, _, _ = select.select([fd, sys.stdin.buffer], [], [])
        if fd in ready:
            try: data = os.read(fd, 65536)
            except OSError: break
            if not data: break
            os.write(1, data)
            if b'\\x1b[6n' in data: os.write(fd, b'\\x1b[1;1R')
            if b'\\x1b[c' in data: os.write(fd, b'\\x1b[?1;2c')
        if sys.stdin.buffer in ready:
            data = os.read(0, 4096)
            if not data: break
            os.write(fd, data)
finally:
    if os.waitpid(pid, os.WNOHANG) == (0, 0):
        os.kill(pid, signal.SIGTERM)
        signal.signal(signal.SIGALRM, lambda _signum, _frame: os.kill(pid, signal.SIGKILL))
        signal.alarm(5)
        os.waitpid(pid, 0)
        signal.alarm(0)
    os.close(fd)
`;

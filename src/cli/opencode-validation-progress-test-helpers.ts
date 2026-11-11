/** Test-only transport fixture. No FlowGuard workflow, ValidationAttempt or PASS authority. */
export const PROGRESS_PROBE_RPC = {
  id: 'flowguard-progress-probe',
  methods: {
    Get: {
      input: {
        type: 'object',
        properties: { sessionID: { type: 'string' } },
        required: ['sessionID'],
        additionalProperties: false,
      },
      output: {
        anyOf: [
          { type: 'null' },
          {
            type: 'object',
            properties: {
              runID: { type: 'string' },
              sessionID: { type: 'string' },
              phase: { type: 'string' },
              source: { type: 'string' },
              status: { type: 'string' },
            },
            required: ['runID', 'sessionID', 'phase', 'source', 'status'],
            additionalProperties: false,
          },
        ],
      },
      errors: {},
    },
  },
  events: {},
} as const;

/** A held Promise is a transport barrier, deliberately not a subprocess-start claim. */
export const PROGRESS_PROBE_SERVER = `
import { Rpc } from '@opencode/plugin/rpc';
import { randomUUID } from 'node:crypto';
import { existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
const Contract = Rpc.define(${JSON.stringify(PROGRESS_PROBE_RPC)});
export default Plugin.define({ id: 'flowguard-progress-probe', async setup(ctx) {
  const snapshots = new Map();
  const controller = new AbortController();
  const registrations = [];
  const record = value => appendFileSync(join(ctx.location.directory, 'observer.jsonl'), JSON.stringify(value) + '\\n');
  const instanceID = randomUUID();
  record({ type: 'setup', instanceID, location: ctx.location });
  async function run(sessionID, phase, source, native) {
    const runID = randomUUID();
    const snapshot = { runID, sessionID, phase, source, status: 'pending' };
    snapshots.set(sessionID, snapshot);
    record({ type: 'started', instanceID, ...snapshot });
    if (native) await native.progress({ title: 'FG probe pending ' + phase, ...snapshot });
    while (!existsSync(join(ctx.location.directory, 'release-' + runID))) {
      if (controller.signal.aborted) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    snapshots.set(sessionID, { ...snapshot, status: 'completed' });
    record({ type: 'completed', ...snapshot, status: 'completed' });
    return { content: 'Transport fixture completed; not validation evidence.' };
  }
  let reads = 0;
  registrations.push(await ctx.rpc.register(Contract, {
    Get: async ({ sessionID }) => {
      const snapshot = snapshots.get(sessionID) ?? null;
      if (reads++ < 10) record({ type: 'read', instanceID, sessionID, found: snapshot !== null });
      return snapshot;
    },
  }));
  registrations.push(await ctx.tool.transform(editor => editor.add({
    name: 'flowguard_progress_probe', description: 'Held transport fixture; not a FlowGuard check.',
    input: { type: 'object', properties: {}, additionalProperties: false },
    options: { codemode: false },
    execute: (_input, native) => run(native.sessionID, 'VALIDATION', 'tool', native),
  })));
  registrations.push(await ctx.command.transform(editor => editor.add({
    name: 'progress-probe', description: 'Held native command transport fixture.',
    execute: async ({ sessionID, prompt }) => { await run(sessionID, prompt.text, 'command'); },
  })));
  const events = (async () => {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      if (event.type.startsWith('session.')) record({ type: 'native-event', event });
    }
  })();
  void events.catch(error => { if (!controller.signal.aborted) record({ type: 'error', message: String(error) }); });
  return async () => {
    controller.abort();
    await Promise.allSettled(registrations.map(registration => registration.dispose()));
    await events.catch(() => {});
  };
} });
`;

/** Optional read-only TUI observer. A toast proves rendering, not production UI design. */
export function progressProbeTui(project: string): string {
  return `
import { Plugin } from '@opencode/plugin/tui';
import { Rpc } from '@opencode/plugin/rpc';
import { appendFileSync } from 'node:fs';
const Contract = Rpc.define(${JSON.stringify(PROGRESS_PROBE_RPC)});
export default Plugin.define({ id: 'flowguard-progress-probe-ui', setup(ctx) {
  const file = ${JSON.stringify(project)} + '/ui-progress.jsonl';
  const record = value => appendFileSync(file, JSON.stringify(value) + '\\n');
  let closed = false;
  let busy = false;
  let previous = '';
  const timer = setInterval(async () => {
    if (closed || busy) return;
    const route = ctx.ui.router.current();
    if (route.type !== 'session') return;
    const session = ctx.data.session.get(route.sessionID);
    if (!session) return;
    busy = true;
    try {
      const snapshot = await ctx.client.rpc(Contract).Get({ sessionID: route.sessionID }, {
        location: session.location, signal: AbortSignal.timeout(2000),
      });
      const current = ctx.ui.router.current();
      if (closed || current.type !== 'session' || current.sessionID !== route.sessionID || !snapshot) return;
      const key = JSON.stringify(snapshot);
      if (previous === key) return;
      previous = key;
      record({ type: 'snapshot', ...snapshot });
      ctx.ui.toast.show({ message: 'FG RPC ' + snapshot.phase + ' ' + snapshot.status, duration: 30000 });
    } catch (error) {
      if (!closed) record({ type: 'error', message: String(error) });
    } finally { busy = false; }
  }, 100);
  record({ type: 'ready', location: ctx.location ?? null });
  return () => { closed = true; clearInterval(timer); };
} });
`;
}

/** Real POSIX PTY only; owns and reaps its own TUI child. */
export const PROGRESS_PROBE_PTY = `
import fcntl, os, pty, select, signal, struct, sys, termios
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 140, 0, 0))
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

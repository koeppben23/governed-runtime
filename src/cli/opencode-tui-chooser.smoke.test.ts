/** Installed pinned-host proof for the actual FlowGuard TUI chooser.
 * The real packed artifact, installer, installed TUI wrapper, canonical command
 * channel and workflow tool run here. Only the PTY and model wire are fixtures. */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FlowGuardGovernance } from '../integration/opencode-governance-rpc.js';
import { hashBuffer } from '../shared/hashing.js';
import { createNativeHostProbe, type NativeHostProbe } from './opencode-native-test-helpers.js';
import { TUI_PLUGIN_RELATIVE_PATH } from './templates.js';

const LIVE = process.env.OPENCODE_LIVE === '1' || process.env.FLOWGUARD_OPENCODE_HOST_E2E === '1';
const REPO = fileURLToPath(new URL('../..', import.meta.url));

/** Drop terminal control sequences so a split repaint reads as plain text. */
const ANSI_CSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
function plain(text: string): string {
  return text.replace(ANSI_CSI, '');
}
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

/** Pack this build and install the packed bytes into the isolated host config. */
async function installPackedProduct(
  project: string,
  env: NodeJS.ProcessEnv,
  scope: 'repo' | 'global',
): Promise<void> {
  const root = dirname(project);
  let tarball: string;
  if (process.env.FLOWGUARD_TARBALL) {
    const supplied = resolve(process.env.FLOWGUARD_TARBALL);
    tarball = join(root, basename(supplied));
    await copyFile(supplied, tarball);
    await copyFile(join(dirname(supplied), 'checksums.sha256'), join(root, 'checksums.sha256'));
  } else {
    const packed = JSON.parse(
      execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root], {
        cwd: REPO,
        env,
        encoding: 'utf8',
        timeout: 60_000,
      }),
    ) as Array<{ filename: string }>;
    tarball = join(root, packed[0]!.filename);
    await writeFile(
      join(root, 'checksums.sha256'),
      `${hashBuffer(await readFile(tarball))}  ${basename(tarball)}\n`,
    );
  }

  const bootstrap = join(root, 'bootstrap');
  execFileSync(
    'npm',
    ['install', '--prefix', bootstrap, '--ignore-scripts', '--no-audit', '--no-fund', tarball],
    { cwd: root, env, encoding: 'utf8', timeout: 300_000 },
  );
  const installer = join(bootstrap, 'node_modules/@flowguard/core/dist/cli/install.js');
  execFileSync(
    process.execPath,
    [installer, 'install', '--install-scope', scope, '--core-tarball', tarball],
    { cwd: project, env, encoding: 'utf8', timeout: 300_000 },
  );
}

describe.skipIf(!LIVE)('installed TUI workflow chooser', () => {
  it('opens, cancels without transition, then selects /task through the native command channel', async () => {
    const ticketText =
      '# TICKET: Installed TUI chooser proof\n\nSelecting /task through the installed chooser records this ticket.';
    let ticketRequested = false;
    probe = await createNativeHostProbe({
      async prepare(project, env) {
        env.FLOWGUARD_INSTALL_LOCK_PATH = join(project, '.install.lock');
        await installPackedProduct(project, env, 'global');
      },
      script: (body, _sessionID) => {
        if (
          !ticketRequested &&
          JSON.stringify(body.messages).includes('Record a governed task description')
        ) {
          ticketRequested = true;
          return { tool: { name: 'flowguard_ticket', arguments: { text: ticketText } } };
        }
        return { text: 'Done.' };
      },
    });
    const session = await probe.session();
    const commands = await probe.client.command.list({ location: probe.location });
    expect(commands.data.map((command) => command.name)).toContain('task');
    const configDir = probe.env.OPENCODE_CONFIG_DIR!;
    expect(existsSync(join(configDir, TUI_PLUGIN_RELATIVE_PATH))).toBe(true);
    expect(existsSync(join(configDir, 'node_modules/@flowguard/core'))).toBe(true);

    const baseUrl = probe.output().match(/listening on\s+(https?:\/\/\S+)/)?.[1];
    expect(baseUrl).toBeDefined();

    let output = '';
    const tui = spawn(
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
    ui = tui;
    tui.stdout?.on('data', (chunk) => {
      output = (output + String(chunk)).slice(-100_000);
    });
    tui.stderr?.on('data', (chunk) => {
      output = (output + String(chunk)).slice(-100_000);
    });
    let startupError: Error | undefined;
    tui.once('error', (error) => {
      startupError = error;
    });

    await vi.waitFor(
      () => {
        expect(startupError, output).toBeUndefined();
        expect(tui.exitCode, output).toBeNull();
      },
      { timeout: 30_000 },
    );

    await probe.client.session.command({ sessionID: session.id, name: 'start', text: '' });
    await vi.waitFor(
      () => {
        expect(output).toMatch(/FlowGuard governance is ACTIVE/i);
      },
      { timeout: 30_000 },
    );

    const openChooser = async (): Promise<void> => {
      tui.stdin?.write('/choose-workflow\r');
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (!/Choose a workflow/i.test(output)) tui.stdin?.write('\r');
      await vi.waitFor(
        () => {
          expect(output).toMatch(/Choose a workflow/i);
        },
        { timeout: 30_000 },
      );
    };

    await openChooser();
    tui.stdin?.write('\x1b');
    await new Promise((resolve) => setTimeout(resolve, 750));
    const afterCancel = await probe.client
      .rpc(FlowGuardGovernance)
      .GetNextAction({ sessionID: session.id });
    expect(afterCancel).toMatchObject({ kind: 'choose_flow', phase: 'READY' });

    output = '';
    await openChooser();
    tui.stdin?.write('\r');
    await vi.waitFor(
      () => {
        expect(plain(output)).toMatch(/Describe[\s\S]*task,[\s\S]*--file/);
      },
      { timeout: 30_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    tui.stdin?.write('Record the installed TUI chooser proof\r');
    await vi.waitFor(
      async () => {
        const view = await probe!.client
          .rpc(FlowGuardGovernance)
          .GetNextAction({ sessionID: session.id });
        expect(view.phase).toBe('TICKET');
        expect(view.kind).toBe('next_action');
        expect(view.actions.map((action) => action.invocation)).toEqual(['/plan']);
      },
      { timeout: 60_000 },
    );
    expect(probe.errors).toEqual([]);
  }, 300_000);
});

// Isolated UI harness only. The real host parses bytes from a real PTY; no
// mocked UI callbacks or application-supplied origin fields are used.
const PTY = `
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

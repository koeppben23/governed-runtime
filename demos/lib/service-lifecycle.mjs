/** Dedicated, authenticated OpenCode child for one live-demo run. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { HOST_SERVICE_PORT } from './host-config.mjs';
import { requestLoopback } from './host-http.mjs';

const ADDRESS = '127.0.0.1';
export const SKIP_ASSERTION_ENV = 'FLOWGUARD_LIVE_SKIP_ASSERTION';

class HostServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function assertFreePort(port) {
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', () =>
      reject(
        new HostServiceError('HOST_SERVICE_PORT_IN_USE', `cannot reserve loopback port ${port}`),
      ),
    );
    socket.listen({ host: ADDRESS, port, exclusive: true }, resolve);
  });
  await new Promise((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
}

function startupEnvironment(configDir, password, skipAssertion) {
  const env = {
    ...process.env,
    OPENCODE_CONFIG_DIR: configDir,
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_PASSWORD: password,
    OPENCODE_DB: path.join(configDir, 'host.sqlite'),
    XDG_DATA_HOME: path.join(configDir, 'xdg-data'),
    XDG_STATE_HOME: path.join(configDir, 'xdg-state'),
    XDG_CACHE_HOME: path.join(configDir, 'xdg-cache'),
    XDG_CONFIG_HOME: path.join(configDir, 'xdg-config'),
    NO_PROXY: [process.env.NO_PROXY, process.env.no_proxy, '127.0.0.1', 'localhost']
      .filter(Boolean)
      .join(','),
  };
  env.no_proxy = env.NO_PROXY;
  for (const key of [
    'PWD',
    'OPENCODE_SERVER',
    'OPENCODE_SERVER_URL',
    'OPENCODE_PORT',
    'OPENCODE_SERVER_PASSWORD',
    'OPENCODE_SERVER_USERNAME',
    'OPENCODE_CONFIG',
    SKIP_ASSERTION_ENV,
  ])
    delete env[key];
  if (skipAssertion) env[SKIP_ASSERTION_ENV] = '1';
  return Object.freeze(env);
}

function waitForListening(child, url) {
  return new Promise((resolve, reject) => {
    const failed = () =>
      finish(
        new HostServiceError(
          'HOST_SERVICE_STARTUP_FAILED',
          'isolated OpenCode did not bind the expected loopback port',
        ),
      );
    const timer = setTimeout(failed, 30_000);
    const buffers = new Map();
    const streams = [child.stdout, child.stderr];
    const consumers = streams.map((stream) => (chunk) => {
      const buffer = (buffers.get(stream) ?? '') + String(chunk);
      const lines = buffer.split(/\r?\n/);
      buffers.set(stream, lines.pop().slice(-4096));
      if (lines.some((line) => line.trim().endsWith(`listening on ${url}`))) finish();
    });
    function finish(error) {
      clearTimeout(timer);
      child.off('error', failed);
      child.off('exit', failed);
      streams.forEach((stream, index) => stream.off('data', consumers[index]));
      if (error) reject(error);
      else resolve();
    }
    streams.forEach((stream, index) => stream.on('data', consumers[index]));
    child.once('error', failed);
    child.once('exit', failed);
  });
}

export async function withIsolatedService(
  {
    configDir,
    skipAssertion = false,
    port = HOST_SERVICE_PORT,
    command = 'opencode',
    argsPrefix = /** @type {string[]} */ ([]),
  },
  use,
) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HostServiceError('HOST_SERVICE_PORT_INVALID', 'invalid isolated OpenCode port');
  }
  const url = `http://${ADDRESS}:${port}`;
  const cwd = path.resolve(configDir);
  const password = randomUUID();
  const env = startupEnvironment(cwd, password, skipAssertion);
  await assertFreePort(port);
  const child = spawn(
    command,
    [...argsPrefix, 'serve', `--hostname=${ADDRESS}`, `--port=${port}`],
    {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let live = true;
  child.once('exit', () => {
    live = false;
  });
  const closed = new Promise((resolve) =>
    child.once('close', () => {
      live = false;
      resolve();
    }),
  );
  child.on('error', () => {
    live = false;
  });
  const stop = async () => {
    if (!live) return closed;
    child.kill('SIGTERM');
    const kill = setTimeout(() => child.kill('SIGKILL'), 5_000);
    try {
      await closed;
    } finally {
      clearTimeout(kill);
    }
  };
  let interrupt;
  const interrupted = new Promise((_, reject) => {
    interrupt = reject;
  });
  const onSignal = () =>
    interrupt(new HostServiceError('HOST_SERVICE_INTERRUPTED', 'isolated host run interrupted'));
  const assertAlive = () => {
    if (!live)
      throw new HostServiceError('HOST_SERVICE_STOPPED', 'isolated OpenCode is not running');
  };
  const onInt = onSignal;
  const onTerm = onSignal;
  process.once('SIGINT', onInt);
  process.once('SIGTERM', onTerm);
  try {
    await Promise.race([waitForListening(child, url), interrupted]);
    // Drain startup and subsequent host output without retaining bodies, secrets or logs.
    child.stdout.resume();
    child.stderr.resume();
    const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
    const probe = (headers) =>
      requestLoopback(port, '/api/session', { method: 'GET', headers }, 5_000);
    const owned = async () =>
      (await probe({})).status === 401 && (await probe({ authorization })).status === 200 && live;
    if (!(await Promise.race([owned(), interrupted]))) {
      throw new HostServiceError(
        'HOST_SERVICE_OWNERSHIP_UNPROVEN',
        'isolated OpenCode did not prove authenticated ownership',
      );
    }
    return await Promise.race([
      use({
        url,
        envFor: (workspace) => {
          assertAlive();
          return { ...env, PWD: workspace };
        },
        async request(route, { method, body }, timeoutMs) {
          assertAlive();
          return requestLoopback(
            port,
            route,
            {
              method,
              headers: {
                authorization,
                ...(body === undefined ? {} : { 'content-type': 'application/json' }),
              },
              body,
            },
            timeoutMs,
          );
        },
      }),
      interrupted,
    ]);
  } finally {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
    child.stdout.resume();
    child.stderr.resume();
    await stop();
  }
}

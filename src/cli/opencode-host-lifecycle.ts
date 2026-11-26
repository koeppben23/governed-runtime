/**
 * @module cli/opencode-host-lifecycle
 * @description Post-install verification and restart of the running OpenCode
 * service for the native FlowGuard plugin.
 *
 * The installer must not claim that a running host loaded the plugin merely
 * because files exist. OpenCode exposes the actual local-plugin state through
 * its loopback service API. This module reads that state, restarts the exact
 * service executable when the plugin is failed and the installer is not inside
 * that service, then verifies both the plugin and `/start`.
 *
 * Safety boundaries live in opencode-host-service.ts: only loopback records and
 * verified `opencode serve --service` processes are accepted. This module owns
 * the decision and verification flow, and refuses to restart its own host
 * ancestor. It is host lifecycle verification, not governance activation.
 */

import { dirname, join, resolve } from 'node:path';
import type { CliError, CliNotice, InstallScope } from './install-types.js';
import {
  createDefaultAdapter,
  defaultServiceRecordPath,
  isLoopbackServiceUrl,
  isOpenCodeServiceProcess,
  normalizePluginPath,
  SERVICE_RECORD_SCHEMA,
  type HostLifecycleAdapter,
  type HostProbe,
  type HostProcessInfo,
  type OpenCodeService,
} from './opencode-host-service.js';

export type HostLifecycleStatus =
  | 'no-service'
  | 'active'
  | 'restarted'
  | 'restart-scheduled'
  | 'restart-required'
  | 'restart-failed'
  | 'unverified';

export interface HostLifecycleResult {
  status: HostLifecycleStatus;
  readonly notices: CliNotice[];
  readonly warnings: string[];
  readonly errors: string[];
  readonly errorDetails: CliError[];
}

export interface HostLifecycleInput {
  readonly target: string;
  readonly scope: InstallScope;
  readonly allowRestart: boolean;
  /** Restart after an applied install even when the old plugin is still active. */
  readonly forceRestart?: boolean;
  readonly serviceRecordPath?: string;
  readonly probeTimeoutMs?: number;
  readonly restartTimeoutMs?: number;
  readonly adapter?: HostLifecycleAdapter;
}

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_RESTART_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 500;
const MAX_ANCESTRY = 64;

function expectedPluginPath(target: string): string {
  return normalizePluginPath(join(target, 'plugins', 'flowguard'));
}

function activeProbe(probe: HostProbe, target: string): boolean {
  return (
    probe.reachable &&
    probe.pluginPath === expectedPluginPath(target) &&
    probe.pluginStatus === 'active' &&
    probe.hasStart
  );
}

function repoLocationMatches(scope: InstallScope, target: string, probe: HostProbe): boolean {
  if (scope !== 'repo' || probe.location === null) return true;
  return resolve(probe.location) === resolve(dirname(target));
}

function commandFor(executable: string): string {
  return `'${executable.replace(/'/g, `'\\''`)}' service restart`;
}

async function isInsideService(
  servicePid: number,
  adapter: HostLifecycleAdapter,
): Promise<boolean | null> {
  if (servicePid === process.pid) return true;
  let current = process.pid;
  for (let depth = 0; depth < MAX_ANCESTRY; depth++) {
    const info = await adapter.processInfo(current);
    if (info === null) return null;
    if (info.parentPid === servicePid) return true;
    if (info.parentPid <= 1 || info.parentPid === current) return false;
    current = info.parentPid;
  }
  return null;
}

function warning(result: HostLifecycleResult, message: string): void {
  result.warnings.push(message);
}

function error(
  result: HostLifecycleResult,
  code:
    | 'HOST_SERVICE_UNSAFE_URL'
    | 'HOST_SERVICE_STALE'
    | 'HOST_SERVICE_RECORD_INVALID'
    | 'HOST_RESTART_REQUIRED'
    | 'HOST_RESTART_FAILED'
    | 'HOST_PLUGIN_MISMATCH'
    | 'HOST_COMMAND_MISSING'
    | 'HOST_VERIFICATION_UNAVAILABLE',
  message: string,
  recoveryContext?: CliError['recoveryContext'],
): void {
  result.errors.push(message);
  result.errorDetails.push({
    code,
    message,
    ...(recoveryContext === undefined ? {} : { recoveryContext }),
  });
}

function result(status: HostLifecycleStatus): HostLifecycleResult {
  return { status, notices: [], warnings: [], errors: [], errorDetails: [] };
}

type LoadedService = {
  readonly service: OpenCodeService;
  readonly processRecord: HostProcessInfo;
};

async function loadService(
  input: HostLifecycleInput,
  adapter: HostLifecycleAdapter,
  outcome: HostLifecycleResult,
): Promise<LoadedService | null> {
  if (adapter.platform !== 'darwin' && adapter.platform !== 'linux') {
    outcome.notices.push({
      kind: 'next',
      message:
        'OpenCode host lifecycle verification is not supported on this platform; restart OpenCode manually if the native plugin was already loaded by an older process.',
    });
    return null;
  }
  const recordPath = input.serviceRecordPath ?? defaultServiceRecordPath();
  let raw: unknown;
  try {
    raw = await adapter.readServiceRecord(recordPath);
  } catch (readError) {
    warning(
      outcome,
      `OpenCode service record could not be read (${readError instanceof Error ? readError.message : String(readError)}); host verification is NOT_VERIFIED.`,
    );
    error(
      outcome,
      'HOST_VERIFICATION_UNAVAILABLE',
      'The running OpenCode service could not be verified.',
    );
    return null;
  }
  if (raw === undefined) {
    outcome.status = 'no-service';
    outcome.notices.push({
      kind: 'next',
      message:
        'No running OpenCode service was detected; start OpenCode to load the plugin. Installation does not activate governance.',
    });
    return null;
  }
  const parsed = SERVICE_RECORD_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    error(
      outcome,
      'HOST_SERVICE_RECORD_INVALID',
      `The OpenCode service record at ${recordPath} is invalid; refusing to use it as a process-restart authority.`,
    );
    return null;
  }
  const service = parsed.data;
  if (!isLoopbackServiceUrl(service.url)) {
    error(
      outcome,
      'HOST_SERVICE_UNSAFE_URL',
      `The OpenCode service record URL is not loopback; refusing to send credentials or restart it: ${service.url}`,
    );
    return null;
  }
  const processRecord = await adapter.processInfo(service.pid);
  if (processRecord === null || !isOpenCodeServiceProcess(processRecord)) {
    warning(
      outcome,
      `The OpenCode service record points to PID ${service.pid}, but no live opencode serve --service process matches it; no process was signalled.`,
    );
    error(
      outcome,
      'HOST_SERVICE_STALE',
      'The running OpenCode service could not be identified from its record.',
    );
    return null;
  }
  return { service, processRecord };
}

function isCurrentActivePlugin(input: HostLifecycleInput, probe: HostProbe | null): boolean {
  if (probe === null || input.forceRestart === true) return false;
  return activeProbe(probe, input.target);
}

/** Returns the probe when a restart decision is still needed, null when terminal. */
function evaluateProbe(
  input: HostLifecycleInput,
  probe: HostProbe | null,
  outcome: HostLifecycleResult,
): HostProbe | null {
  if (probe?.reachable && !repoLocationMatches(input.scope, input.target, probe)) {
    outcome.notices.push({
      kind: 'next',
      message: `OpenCode is serving ${probe.location}; this repo-scoped installation will load when that project is opened. Installation does not activate governance.`,
    });
    return null;
  }
  if (
    probe?.reachable &&
    probe.pluginPath !== null &&
    probe.pluginPath !== expectedPluginPath(input.target)
  ) {
    error(
      outcome,
      'HOST_PLUGIN_MISMATCH',
      `OpenCode loaded a different FlowGuard plugin at ${probe.pluginPath}; expected ${expectedPluginPath(input.target)}. No restart was attempted.`,
    );
    return null;
  }
  if (isCurrentActivePlugin(input, probe)) {
    outcome.status = 'active';
    outcome.notices.push({
      kind: 'status',
      message:
        'OpenCode loaded the installed FlowGuard plugin; native /start is available. Installation does not activate governance.',
    });
    return null;
  }
  if (probe === null || !probe.reachable) {
    warning(
      outcome,
      'The OpenCode service did not answer its loopback API; plugin load and /start remain NOT_VERIFIED. No restart was attempted.',
    );
    error(
      outcome,
      'HOST_VERIFICATION_UNAVAILABLE',
      'The running OpenCode service could not be verified.',
    );
    return null;
  }
  return probe;
}

function requireRestart(
  input: HostLifecycleInput,
  probe: HostProbe,
  processRecord: HostProcessInfo,
  inside: boolean | null,
  outcome: HostLifecycleResult,
): boolean {
  if (inside === false && input.allowRestart) return false;
  outcome.status = 'restart-required';
  const reason =
    probe.pluginStatus === 'failed'
      ? `the plugin is failed${probe.pluginRef ? ` (${probe.pluginRef})` : ''}`
      : probe.pluginStatus === 'active'
        ? 'the loaded plugin must be refreshed after the applied install'
        : 'the plugin was not discovered';
  const why =
    inside === null
      ? 'the installer could not prove it is outside the running service'
      : inside
        ? 'the installer is running inside that service'
        : 'automatic restart is disabled';
  error(
    outcome,
    'HOST_RESTART_REQUIRED',
    `FlowGuard was installed, but ${reason} and ${why}. Finish active work, then restart the exact service: ${commandFor(processRecord.executable)}`,
    { target: processRecord.executable },
  );
  return true;
}

async function scheduleRestartAndReport(
  adapter: HostLifecycleAdapter,
  loaded: LoadedService,
  outcome: HostLifecycleResult,
): Promise<void> {
  try {
    await adapter.scheduleRestart(loaded.processRecord.executable);
    outcome.status = 'restart-scheduled';
    outcome.notices.push({
      kind: 'next',
      message:
        'Scheduled the exact OpenCode service restart after this installer exits. The current host session will be interrupted; after the service returns, verify native /start. Installation does not activate governance.',
    });
  } catch (scheduleError) {
    outcome.status = 'restart-failed';
    error(
      outcome,
      'HOST_RESTART_FAILED',
      `The OpenCode service restart could not be scheduled: ${scheduleError instanceof Error ? scheduleError.message : String(scheduleError)}. Installed artifacts remain committed.`,
      { target: loaded.processRecord.executable },
    );
  }
}

async function pollProbe(
  service: OpenCodeService,
  target: string,
  timeoutMs: number,
  adapter: HostLifecycleAdapter,
): Promise<HostProbe | null> {
  const deadline = adapter.now() + timeoutMs;
  let last: HostProbe | null = null;
  for (;;) {
    last = await adapter.probe(service, target);
    if (last.reachable && last.pluginStatus === 'failed') return last;
    if (activeProbe(last, target)) return last;
    if (adapter.now() >= deadline) return last;
    await adapter.sleep(POLL_INTERVAL_MS);
  }
}

async function rereadService(
  recordPath: string,
  timeoutMs: number,
  adapter: HostLifecycleAdapter,
): Promise<OpenCodeService | null> {
  const deadline = adapter.now() + timeoutMs;
  for (;;) {
    try {
      const raw = await adapter.readServiceRecord(recordPath);
      const parsed = SERVICE_RECORD_SCHEMA.safeParse(raw);
      if (parsed.success) {
        const info = await adapter.processInfo(parsed.data.pid);
        if (
          info !== null &&
          isOpenCodeServiceProcess(info) &&
          isLoopbackServiceUrl(parsed.data.url)
        ) {
          // A supervisor may restart via exec and keep the PID; plugin
          // activation below remains the authoritative verification.
          return parsed.data;
        }
      }
    } catch {
      // A transient read failure during restart is retried.
    }
    if (adapter.now() >= deadline) return null;
    await adapter.sleep(POLL_INTERVAL_MS);
  }
}

async function performRestart(
  adapter: HostLifecycleAdapter,
  loaded: LoadedService,
  outcome: HostLifecycleResult,
): Promise<boolean> {
  try {
    await adapter.restart(loaded.processRecord.executable);
    return true;
  } catch (restartError) {
    outcome.status = 'restart-failed';
    error(
      outcome,
      'HOST_RESTART_FAILED',
      `The OpenCode service restart failed: ${restartError instanceof Error ? restartError.message : String(restartError)}. Installed artifacts remain committed.`,
      { target: loaded.processRecord.executable },
    );
    return false;
  }
}

function restartFailureEvidence(probe: HostProbe | null): string {
  if (probe === null || !probe.reachable) return 'is unreachable';
  const ref = probe.pluginRef ? ` (${probe.pluginRef})` : '';
  return `is ${probe.pluginStatus}${ref}`;
}

function restartFailureCode(
  probe: HostProbe | null,
): 'HOST_COMMAND_MISSING' | 'HOST_RESTART_FAILED' {
  return probe?.reachable && probe.pluginStatus === 'active'
    ? 'HOST_COMMAND_MISSING'
    : 'HOST_RESTART_FAILED';
}

async function restartAndVerify(
  input: HostLifecycleInput,
  adapter: HostLifecycleAdapter,
  loaded: LoadedService,
  outcome: HostLifecycleResult,
): Promise<void> {
  const restartCommand = commandFor(loaded.processRecord.executable);
  if (!(await performRestart(adapter, loaded, outcome))) return;
  const timeout = input.restartTimeoutMs ?? DEFAULT_RESTART_TIMEOUT_MS;
  const replacement = await rereadService(
    input.serviceRecordPath ?? defaultServiceRecordPath(),
    timeout,
    adapter,
  );
  if (replacement === null) {
    outcome.status = 'restart-failed';
    error(
      outcome,
      'HOST_RESTART_FAILED',
      `The OpenCode service did not publish a replacement service record after restart. Installed artifacts remain committed; verify the host log and retry: ${restartCommand}`,
      { target: loaded.processRecord.executable },
    );
    return;
  }
  const probe = await pollProbe(replacement, input.target, timeout, adapter);
  if (probe !== null && activeProbe(probe, input.target)) {
    outcome.status = 'restarted';
    outcome.notices.push({
      kind: 'status',
      message:
        'Restarted the exact OpenCode service; the FlowGuard plugin is active and native /start is available. Installation does not activate governance.',
    });
    return;
  }
  outcome.status = 'restart-failed';
  error(
    outcome,
    restartFailureCode(probe),
    `The OpenCode service restarted, but the FlowGuard plugin ${restartFailureEvidence(probe)} and native /start is ${probe?.hasStart ? 'present' : 'missing'}. Installed artifacts remain committed; verify the host log and retry: ${restartCommand}`,
    { target: loaded.processRecord.executable },
  );
}

export async function runOpenCodeHostLifecycle(
  input: HostLifecycleInput,
): Promise<HostLifecycleResult> {
  const adapter = input.adapter ?? createDefaultAdapter();
  const outcome = result('unverified');
  const loaded = await loadService(input, adapter, outcome);
  if (loaded === null) return outcome;
  const inside = await isInsideService(loaded.service.pid, adapter);
  const probe = evaluateProbe(
    input,
    await pollProbe(
      loaded.service,
      input.target,
      input.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      adapter,
    ),
    outcome,
  );
  if (probe === null) return outcome;
  if (inside === true) {
    if (input.allowRestart) {
      await scheduleRestartAndReport(adapter, loaded, outcome);
    } else {
      requireRestart(input, probe, loaded.processRecord, inside, outcome);
    }
    return outcome;
  }
  if (requireRestart(input, probe, loaded.processRecord, inside, outcome)) return outcome;
  await restartAndVerify(input, adapter, loaded, outcome);
  return outcome;
}

/** Pure merge used by the CLI boundary; lifecycle failures become install errors. */
export function applyHostLifecycle(
  target: {
    notices?: CliNotice[];
    warnings: string[];
    errors: string[];
    errorDetails?: CliError[];
  },
  lifecycle: HostLifecycleResult,
): void {
  target.notices = [...(target.notices ?? []), ...lifecycle.notices];
  target.warnings.push(...lifecycle.warnings);
  target.errors.push(...lifecycle.errors);
  target.errorDetails = [...(target.errorDetails ?? []), ...lifecycle.errorDetails];
}

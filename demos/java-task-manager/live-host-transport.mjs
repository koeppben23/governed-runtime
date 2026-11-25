/** Isolated OpenCode dispatch and evidence reservations. */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { eventsOf, toolDenialCodes, toolDenialEvents } from '../lib/transcript.mjs';
import { DemoNotVerifiedError } from '../lib/results.mjs';
import { assertCompleteAuditWindow, readAuditEvents } from '../lib/recovery-state.mjs';
import { HostTransportError } from '../lib/host-http.mjs';
import { withIsolatedService } from '../lib/service-lifecycle.mjs';
import { assertNativeDecisionWitness } from './live-decision-witness.mjs';
import { assertNativeCommandWitness } from './live-native-command-witness.mjs';
import { planPreflightGate } from './live-plan-preflight.mjs';
import { readState } from './live-session-evidence.mjs';
import { run } from './live-matrix-setup.mjs';
export function assertHostCallOk(result, label) {
  if (result.timedOut) throw new Error(`${label}: host process timed out`);
  if (result.code !== 0) throw new Error(`${label}: host exit code ${String(result.code)}`);
  const hostErrors = eventsOf(result.stdout).filter((event) => event.type === 'error');
  if (hostErrors.length > 0) throw new Error(`${label}: host error event observed`);
}

function typedAuditEvidence(events, session, flowguardSessionId) {
  const evidence = [];
  for (const event of events) {
    if (!event.event?.startsWith('tool_call:')) continue;
    if (
      event.hostSessionId !== session.sessionId ||
      event.flowguardSessionId !== flowguardSessionId ||
      !Number.isInteger(event.auditSequence) ||
      typeof event.detail?.tool !== 'string' ||
      event.event !== `tool_call:${event.detail.tool}`
    ) {
      throw new Error(
        `audit event identity/sequence mismatch for ${session.sessionId}: ${String(event.event)}`,
      );
    }
    evidence.push({
      tool: event.detail.tool,
      success: typeof event.detail.success === 'boolean' ? event.detail.success : null,
      errorCode: typeof event.detail.errorCode === 'string' ? event.detail.errorCode : null,
      auditSequence: event.auditSequence,
      occurredAt: typeof event.occurredAt === 'string' ? event.occurredAt : null,
    });
  }
  return evidence;
}

/** Reject success flags or error codes that cannot distinguish success from refusal. */
export function assertTypedAuditConsistency(evidence, label) {
  for (const event of evidence) {
    if (typeof event.success !== 'boolean' || typeof event.tool !== 'string' || !event.tool) {
      throw new DemoNotVerifiedError(`${label}: audit evidence has no unambiguous tool outcome`);
    }
    if (event.success === false && (!event.errorCode || typeof event.errorCode !== 'string')) {
      throw new DemoNotVerifiedError(`${label}: failed audit event has no error code`);
    }
    if (event.success === true && event.errorCode !== null && event.errorCode !== undefined) {
      throw new DemoNotVerifiedError(`${label}: successful audit event carries an error code`);
    }
  }
}

function expectedDecisionVerdict(command) {
  if (command === 'approve') return 'approve';
  if (command === 'override-approve') return 'approve_with_governance_override';
  if (command === 'request-changes') return 'changes_requested';
  if (command === 'reject') return 'reject';
  return undefined;
}

const HOST_DECISION_COMMANDS = new Set([
  'approve',
  'override-approve',
  'request-changes',
  'reject',
  'review-decision',
]);
export const HOST_NATIVE_COMMANDS = new Set(['start', 'check']);
export const HOST_TRANSPORT_COMMANDS = new Set([
  ...HOST_DECISION_COMMANDS,
  ...HOST_NATIVE_COMMANDS,
]);

function unknownHostOutcome(label) {
  return new HostTransportError(
    'HOST_COMMAND_UNKNOWN_OUTCOME',
    `${label}: native command outcome is unknown; do not retry`,
  );
}

function openEvidence(dir, label, extension) {
  if (!/^[a-zA-Z0-9_-]+$/.test(label)) {
    throw new HostTransportError('HOST_EVIDENCE_INVALID_LABEL', 'invalid evidence filename label');
  }
  try {
    return fs.openSync(path.join(dir, `${label}.${extension}`), 'wx', 0o600);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    throw new HostTransportError(
      'HOST_EVIDENCE_EXISTS',
      `evidence file already exists for ${label}; use a fresh --root`,
    );
  }
}
export async function withHost(runner, use, { skipAssertion = false } = {}) {
  return withIsolatedService({ configDir: runner.configDir, skipAssertion }, async (host) => {
    runner.host = host;
    try {
      return await use();
    } finally {
      runner.host = undefined;
    }
  });
}

export function requireHost(runner) {
  if (!runner.host) {
    throw new HostTransportError(
      'HOST_SERVICE_UNOWNED',
      'no isolated OpenCode child is owned by this run',
    );
  }
  return runner.host;
}

export async function hostCommand(runner, session, label, name, text) {
  const host = runner.requireHost();
  if (!HOST_TRANSPORT_COMMANDS.has(name) || !/^ses_[a-zA-Z0-9_-]+$/.test(session.sessionId ?? '')) {
    throw new HostTransportError(
      'HOST_COMMAND_INVALID',
      'invalid native decision command or session identity',
    );
  }
  const route = `/api/session/${session.sessionId}/command`;
  const body = JSON.stringify({ name, text });
  const evidenceFd = openEvidence(runner.evidenceDir, label, 'jsonl');
  const record = (type, fields = {}) =>
    fs.writeSync(evidenceFd, `${JSON.stringify({ type, ...fields })}\n`);
  let dispatched = false;
  try {
    try {
      const startedAt = Date.now();
      record('host_command_started', {
        timestamp: startedAt,
        sessionID: session.sessionId,
        command: name,
      });
      dispatched = true;
      let response;
      try {
        response = await host.request(
          route,
          { method: 'POST', body },
          runner.options.hostCommandTimeoutMs ?? 120_000,
        );
      } catch {
        record('host_command_error', { code: 'HOST_COMMAND_UNKNOWN_OUTCOME' });
        throw unknownHostOutcome(label);
      }
      const completedAt = Date.now();
      // The durable outcome comes from audit. No HTTP-derived disk writes.
      record('host_command_response_received', { timestamp: completedAt });
      return { ...response, startedAt, completedAt };
    } finally {
      fs.closeSync(evidenceFd);
    }
  } catch (error) {
    if (dispatched) throw unknownHostOutcome(label);
    throw error;
  }
}

export function readAudit(runner, session) {
  const { sessionDir } = runner.requireBoundState(session);
  const file = path.join(sessionDir, 'audit.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

export async function waitForSessionIdle(runner, session) {
  const result = await runner
    .requireHost()
    .request(
      `/api/experimental/session/${session.sessionId}/wait`,
      { method: 'POST' },
      runner.options.sessionWaitTimeoutMs ?? 15 * 60_000,
    );
  if (result.status !== 204) {
    throw new HostTransportError(
      'HOST_SESSION_WAIT_FAILED',
      'isolated host session did not confirm it was idle',
    );
  }
}

export async function productStateDigest(runner, workspace) {
  const cache = (runner.stateDigests ??= new Map());
  if (cache.has(workspace)) return cache.get(workspace);
  const file = path.join(
    workspace,
    '.opencode',
    'node_modules',
    '@flowguard',
    'core',
    'dist',
    'integration',
    'audit-outbox.js',
  );
  if (!fs.existsSync(file)) {
    throw new DemoNotVerifiedError('installed product state-digest authority is unavailable');
  }
  let compute;
  try {
    const module = await import(pathToFileURL(file).href);
    compute = module.computeStateDigest;
  } catch {
    throw new DemoNotVerifiedError('installed product state-digest authority is unreadable');
  }
  if (typeof compute !== 'function') {
    throw new DemoNotVerifiedError('installed product state-digest authority is unavailable');
  }
  cache.set(workspace, compute);
  return compute;
}

export async function createHostSession(runner, session, label) {
  if (!session.workspace) {
    throw new DemoNotVerifiedError(`${label}: native start requires a workspace`);
  }
  const response = await runner.requireHost().request(
    '/api/session',
    {
      method: 'POST',
      body: JSON.stringify({ title: label, location: { directory: session.workspace } }),
      captureBody: true,
    },
    runner.options.hostCommandTimeoutMs ?? 120_000,
  );
  if (response.status !== 200 && response.status !== 201) {
    throw new DemoNotVerifiedError(`${label}: isolated host could not create a session`);
  }
  let id;
  try {
    const parsed = JSON.parse(response.body);
    id = parsed?.data?.id ?? parsed?.id;
  } catch {
    id = undefined;
  }
  if (typeof id !== 'string' || !/^ses_[a-zA-Z0-9_-]+$/.test(id)) {
    throw new DemoNotVerifiedError(`${label}: isolated host returned no valid session identity`);
  }
  return id;
}

export async function hostNativeCommandTransport(runner, session, label, command) {
  if (!session.sessionId) {
    if (command !== 'start') {
      throw new DemoNotVerifiedError(`${label}: native ${command} requires an existing session`);
    }
    session.sessionId = await runner.createHostSession(session, label);
  }
  const before =
    command === 'check'
      ? runner.requireBoundState(session)
      : readState(runner.configDir, session.sessionId);
  if (command === 'start' && before) {
    throw new DemoNotVerifiedError(`${label}: native /start requires an uninitialized session`);
  }
  const auditBefore = before ? readAuditEvents(before.sessionDir) : [];
  if (before) assertCompleteAuditWindow(before.state, 0, auditBefore);
  const response = await runner.hostCommand(session, label, command, '');
  if (response.status !== 204) {
    throw new DemoNotVerifiedError(`${label}: isolated host rejected native ${command}`);
  }
  try {
    await runner.waitForSessionIdle(session);
  } catch {
    throw unknownHostOutcome(label);
  }
  const settledAt = Date.now();
  const after = runner.requireBoundState(session);
  const window = assertNativeCommandWitness({
    command,
    before: before?.state ?? null,
    after: after.state,
    auditBefore,
    events: readAuditEvents(after.sessionDir),
    sessionId: session.sessionId,
    startedAt: response.startedAt,
    completedAt: settledAt,
  });
  const auditEvidence = typedAuditEvidence(window, session, after.state.flowguardSessionId);
  return {
    code: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    durationMs: settledAt - response.startedAt,
    sessionIds: [session.sessionId],
    auditEvidence,
  };
}

export async function hostCommandTransport(runner, session, label, command, options) {
  // Read the full prefix, not just the largest sequence number. Replaced
  // history or a partial tail must not prove a later decision.
  const before = runner.requireBoundState(session);
  if (
    options.expectedPlanGate &&
    !isDeepStrictEqual(
      options.expectedPlanGate,
      planPreflightGate(
        before.state,
        session.sessionId,
        await runner.reviewInvocationAuthority(session.workspace),
      ),
    )
  ) {
    throw new DemoNotVerifiedError(`${label}: plan preflight approval lost its verified plan gate`);
  }
  const auditBefore = readAuditEvents(before.sessionDir);
  assertCompleteAuditWindow(before.state, 0, auditBefore);
  const verdict = expectedDecisionVerdict(command) ?? options.decisionVerdict;
  if (
    !['approve', 'approve_with_governance_override', 'changes_requested', 'reject'].includes(
      verdict,
    ) ||
    (!options.expectedDenial && !options.expectedTargetPhase)
  ) {
    throw new HostTransportError(
      'HOST_COMMAND_INVALID',
      'native decision needs a verdict and an expected outcome',
    );
  }
  const rationale = `Demo dispatch ${randomUUID()}. ${options.decisionRationale ?? ''}`.trim();
  const text = command === 'review-decision' ? `${verdict} ${rationale}` : rationale;
  const response = await runner.hostCommand(session, label, command, text);
  if (response.status !== 204 && (!options.expectedDenial || response.status < 400)) {
    throw unknownHostOutcome(label);
  }
  try {
    await runner.waitForSessionIdle(session);
  } catch {
    throw unknownHostOutcome(label);
  }
  const settledAt = Date.now();
  const stateDigest = await runner.productStateDigest(session.workspace);
  const after = runner.requireBoundState(session);
  const events = readAuditEvents(after.sessionDir);
  const window = assertNativeDecisionWitness({
    before: before.state,
    after: after.state,
    auditBefore,
    events,
    sessionId: session.sessionId,
    startedAt: response.startedAt,
    completedAt: settledAt,
    verdict,
    rationale,
    expectedDenial: options.expectedDenial,
    expectedDenialTool: options.expectedDenialTool,
    expectedTargetPhase: options.expectedTargetPhase,
    stateDigest,
  });
  const auditEvidence = typedAuditEvidence(window, session, after.state.flowguardSessionId);
  const denials = auditEvidence.filter((event) => event.success === false && event.errorCode);
  const durationMs = settledAt - response.startedAt;
  runner.turnObservations.push({
    label,
    exitCode: 0,
    durationMs,
    denialCodes: [...new Set(denials.map((event) => event.errorCode))],
    denialOccurrences: denials.map((event) => event.errorCode),
  });
  return {
    code: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    durationMs,
    sessionIds: [session.sessionId],
    auditEvidence,
  };
}

export async function hostStep(runner, label, workspace, args, timeoutMs = 30 * 60_000) {
  const host = runner.requireHost();
  const stdoutPath = path.join(runner.evidenceDir, `${label}.jsonl`);
  const stdoutFd = openEvidence(runner.evidenceDir, label, 'jsonl');
  let stderrFd;
  try {
    stderrFd = openEvidence(runner.evidenceDir, label, 'err');
  } catch (error) {
    fs.closeSync(stdoutFd);
    throw error;
  }
  let result;
  let output;
  try {
    result = await run('opencode', [args[0], '--server', host.url, ...args.slice(1)], {
      cwd: workspace,
      env: host.envFor(workspace),
      stdout: stdoutFd,
      stderr: stderrFd,
      timeoutMs,
    });
    output = fs.readFileSync(stdoutPath, 'utf8');
  } finally {
    try {
      fs.closeSync(stdoutFd);
    } finally {
      fs.closeSync(stderrFd);
    }
  }
  runner.turnObservations.push({
    label,
    exitCode: result.code,
    durationMs: result.durationMs,
    denialCodes: toolDenialCodes(output),
    denialOccurrences: toolDenialEvents(output).map((denial) => denial.code),
  });
  const sessionIds = [
    ...new Set(
      eventsOf(output)
        .map((event) => event.sessionID)
        .filter(Boolean),
    ),
  ];
  runner.log(`${label}: exit=${String(result.code)} time=${Math.round(result.durationMs / 1000)}s`);
  return { ...result, stdout: output, sessionIds };
}

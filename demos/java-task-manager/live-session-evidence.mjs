/** Read bound session state and collect its external transcript/package evidence. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { eventsOf } from '../lib/transcript.mjs';
import { RESULT } from '../lib/results.mjs';
import { readAuditEvents } from '../lib/recovery-state.mjs';
import { exportHostTranscript } from './live-host-export.mjs';
import { REPO, SCRIPT_DIR, sha256, verificationFlowFor } from './live-matrix-setup.mjs';
export function canonicalPath(target) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

/** The persisted session must be bound to the observed host session and worktree. */
export function assertSessionBinding(state, hostSessionId, workspace) {
  const boundHost = state.binding?.hostSessionId;
  if (boundHost !== hostSessionId) {
    throw new Error(`persisted host binding '${String(boundHost)}' != observed '${hostSessionId}'`);
  }
  const boundWorktree = state.binding?.worktree;
  if (
    typeof boundWorktree !== 'string' ||
    canonicalPath(boundWorktree) !== canonicalPath(workspace)
  ) {
    throw new Error(
      `persisted worktree binding '${String(boundWorktree)}' != delivered workspace '${workspace}'`,
    );
  }
}

/**
 * A live control record may become PASS ONLY after provenance capture has
 * validated every required parent/reviewer transcript, and the payload can
 * never supply `result` itself. Any failure keeps the record FAILED so the
 * aggregate cannot count a falsely passing case.
 */
export async function finalizeControlRecord(
  record,
  session,
  runner,
  payload = {},
  result = RESULT.CONTROL_PASSED,
) {
  record.result = RESULT.FAILED;
  record.hostSessionId = session.sessionId;
  await runner.captureProvenance(record, session);
  const { result: _rejected, ...safePayload } = payload;
  Object.assign(record, safePayload, { result });
  return record;
}

/**
 * Capture provenance on a FAILURE path without touching the result
 * classification: finalizeControlRecord would overwrite it with its default
 * CONTROL_PASSED. A failed run must never become a passed control.
 */
export async function captureFailureProvenance(record, session, runner) {
  try {
    if (session.sessionId) record.hostSessionId = session.sessionId;
    const snapshot = runner.requireBoundState(session);
    record.phase = snapshot.state.phase;
    record.flowguardSessionId = snapshot.state.flowguardSessionId;
    await runner.captureProvenance(record, session);
  } catch (captureError) {
    record.transcriptCaptureError = String(captureError);
  }
  return record;
}

/**
 * Reviewer children named by the parent's own Task tool metadata. Only children
 * whose metadata declares THIS parent are returned; a foreign child is ignored.
 */
export function taskChildSessionIds(output, parentSessionId) {
  const ids = [];
  for (const event of eventsOf(output)) {
    const part = event.part ?? {};
    if (event.type !== 'tool_use' || part.tool !== 'task') continue;
    const metadata = part.state?.metadata ?? {};
    const execution = metadata.flowguardReviewExecution ?? {};
    if (
      metadata.parentSessionId !== parentSessionId &&
      execution.parentSessionId !== parentSessionId
    ) {
      continue;
    }
    for (const candidate of [metadata.sessionId, execution.childSessionId]) {
      if (
        typeof candidate === 'string' &&
        candidate.startsWith('ses_') &&
        candidate !== parentSessionId
      ) {
        ids.push(candidate);
      }
    }
  }
  return [...new Set(ids)];
}

/** Sessions whose transcripts belong to one flow's evidence: parent + reviewers. */
export function transcriptTargets(state, observedChildSessionIds = []) {
  // Every reviewer child is exported: fulfilled invocations, attempt-bound
  // children, observation-bound children, and children named by the parent's
  // Task metadata. A discarded child is exactly the evidence a forensic pass
  // must see.
  const childSessionIds = [
    ...(state.reviewAssurance?.invocations ?? []).map((invocation) => invocation.childSessionId),
    ...(state.reviewAssurance?.attempts ?? []).map((attempt) => attempt.childSessionId),
    ...(state.reviewAssurance?.attempts ?? []).flatMap((attempt) =>
      (attempt.observations ?? []).map((observation) => observation?.observedBySessionId),
    ),
    ...observedChildSessionIds,
  ].filter((sessionId) => typeof sessionId === 'string' && sessionId.length > 0);
  const reviewers = [...new Set(childSessionIds)].filter(
    (sessionId) => sessionId !== state.binding?.hostSessionId,
  );
  return { parent: state.binding?.hostSessionId ?? null, reviewers };
}

/** Persisted reviewer provenance for a child transcript, when the state records one. */
function reviewerBinding(state, sessionId) {
  const invocation = (state.reviewAssurance?.invocations ?? []).find(
    (item) => item.childSessionId === sessionId,
  );
  if (!invocation) return null;
  return {
    obligationId: typeof invocation.obligationId === 'string' ? invocation.obligationId : null,
    invocationId: typeof invocation.invocationId === 'string' ? invocation.invocationId : null,
    attemptId: typeof invocation.attemptId === 'string' ? invocation.attemptId : null,
  };
}

function sessionStateDir(configDir, sessionId) {
  const workspacesRoot = path.join(configDir, 'workspaces');
  if (!fs.existsSync(workspacesRoot)) return null;
  for (const fingerprint of fs.readdirSync(workspacesRoot)) {
    const statePath = path.join(
      workspacesRoot,
      fingerprint,
      'sessions',
      sessionId,
      'session-state.json',
    );
    if (fs.existsSync(statePath)) return { statePath, sessionDir: path.dirname(statePath) };
  }
  return null;
}

export function readState(configDir, sessionId) {
  const found = sessionStateDir(configDir, sessionId);
  if (!found) return null;
  return {
    state: JSON.parse(fs.readFileSync(found.statePath, 'utf8')),
    sessionDir: found.sessionDir,
  };
}

/** Highest persisted audit sequence before the current turn (0 without a trail). */
export function lastAuditSequence(configDir, sessionId) {
  const found = sessionStateDir(configDir, sessionId);
  if (!found) return 0;
  return readAuditEvents(found.sessionDir).reduce(
    (max, event) => Math.max(max, Number(event?.auditSequence) || 0),
    0,
  );
}
export function installedBuild(runner, workspace) {
  const buildInfoPath = path.join(
    workspace,
    '.opencode',
    'node_modules',
    '@flowguard',
    'core',
    'dist',
    'build-info.json',
  );
  if (!fs.existsSync(buildInfoPath)) {
    throw new Error(`installed build info missing: ${buildInfoPath}`);
  }
  return JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'));
}

/** Child sessions the parent's Task metadata names for THIS parent. */
export function observedTaskChildren(runner, session) {
  if (!session.sessionId || !fs.existsSync(runner.evidenceDir)) return [];
  const children = [];
  for (const name of fs.readdirSync(runner.evidenceDir)) {
    if (!name.endsWith('.jsonl')) continue;
    try {
      children.push(
        ...taskChildSessionIds(
          fs.readFileSync(path.join(runner.evidenceDir, name), 'utf8'),
          session.sessionId,
        ),
      );
    } catch {
      continue;
    }
  }
  return children;
}

export async function exportTranscript(runner, label, sessionId, workspace, parentSessionId) {
  const host = runner.requireHost();
  const file = await exportHostTranscript({
    label,
    sessionId,
    workspace,
    parentSessionId,
    evidenceDir: runner.evidenceDir,
    configDir: runner.configDir,
    serverUrl: host.url,
    env: host.envFor(workspace),
  });
  return { sessionId, file: path.relative(runner.evidenceDir, file), sha256: sha256(file) };
}

export async function captureProvenance(runner, flow, session) {
  flow.retryHints = session.retryHints ?? [];
  runner.settleStructuredRearms(session, 'final');
  flow.recoveryObservations = session.recoveryObservations ?? [];
  flow.governedRefusals = session.governedRefusals ?? [];
  flow.recoveredDenials = session.recoveredDenials ?? [];
  const snapshot = runner.requireBoundState(session);
  const targets = transcriptTargets(snapshot.state, runner.observedTaskChildren(session));
  if (targets.parent !== session.sessionId) {
    throw new Error(`${flow.name}: persisted host binding is not the observed session`);
  }
  flow.transcripts = { reviewers: [] };
  flow.transcriptErrors = [];
  flow.transcriptCaptureAttempts = flow.transcriptCaptureAttempts ?? [];
  for (const sessionId of [targets.parent, ...targets.reviewers]) {
    try {
      const exported = await runner.exportTranscript(
        flow.name,
        sessionId,
        session.workspace,
        sessionId === targets.parent ? undefined : targets.parent,
      );
      const binding =
        sessionId === targets.parent ? null : reviewerBinding(snapshot.state, sessionId);
      const record = binding ? { ...exported, reviewBinding: binding } : exported;
      if (sessionId === targets.parent) flow.transcripts.parent = record;
      else flow.transcripts.reviewers.push(record);
      flow.transcriptCaptureAttempts.push({ sessionId, status: 'validated', ...record });
    } catch (error) {
      const failure = { sessionId, reason: error.message };
      flow.transcriptErrors.push(failure);
      flow.transcriptCaptureAttempts.push({ ...failure, status: 'failed' });
    }
  }
  if (flow.transcriptErrors.length > 0) {
    throw Object.assign(
      new Error(
        flow.transcriptErrors.map((entry) => `${entry.sessionId}: ${entry.reason}`).join('; '),
      ),
      {
        code: 'HOST_TRANSCRIPT_CAPTURE_FAILED',
      },
    );
  }
  flow.installedBuild = runner.installedBuild(session.workspace);
}

export function verifyPackage(runner, session, kind, expectFlow, expectPhase, label) {
  const snapshot = runner.requireBoundState(session);
  const archiveDir = path.join(path.dirname(snapshot.sessionDir), 'archive');
  const file =
    kind === 'export'
      ? path.join(archiveDir, `export-${session.sessionId}.tar.gz`)
      : path.join(archiveDir, `${session.sessionId}.tar.gz`);
  if (!fs.existsSync(file)) throw new Error(`${label}: ${kind} package missing`);
  const verification = execFileSync(
    process.execPath,
    [
      path.join(SCRIPT_DIR, 'verify-evidence-package.mjs'),
      file,
      '--expect-session',
      session.sessionId,
      '--expect-flow',
      verificationFlowFor(expectFlow),
      '--expect-phase',
      expectPhase,
    ],
    { cwd: REPO, encoding: 'utf8' },
  );
  if (!/result: VERIFIED/.test(verification)) {
    throw new Error(`${label}: package verification failed`);
  }
  runner.log(`${label}: ${kind} package VERIFIED (${sha256(file).slice(0, 12)}…)`);
  return { kind, file: path.relative(runner.evidenceDir, file), sha256: sha256(file) };
}

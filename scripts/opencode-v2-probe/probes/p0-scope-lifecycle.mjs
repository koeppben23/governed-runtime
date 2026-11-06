#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startProbeHost } from '../lib/host.mjs';
import { pinHost, ProbeError, stopProbeProcess } from '../lib/isolation.mjs';
import {
  normalAnswer,
  correlatedNativeChild,
  nativeChildReference,
  observationDigest,
  sessionBinding,
  stableSnapshots,
  startScopeTrace,
  unchangedBinding,
  waitForObservation,
} from '../lib/scope-evidence.mjs';

const outDir =
  process.env.FG_PROBE_OUT ??
  join(process.cwd(), 'scripts/opencode-v2-probe/evidence/phase02/p0-02-h');
await mkdir(outDir, { recursive: true });
// Each run owns new files; never overwrite a previous observation.
const runDir = join(outDir, new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(runDir);
let parentID;
let holdSeen = false;
let releaseHold;
function script(body, _index, meta) {
  const sid = meta.headers['x-opencode-session-id'];
  const last = body.messages?.at(-1);
  if (JSON.stringify(last).includes('HOLD_FOR_CRASH')) {
    holdSeen = true;
    return new Promise((resolve) => {
      releaseHold = () => resolve({ text: 'LATE_AFTER_CRASH' });
    });
  }
  if (
    sid === parentID &&
    last?.role !== 'tool' &&
    JSON.stringify(last).includes('NATIVE_CHILD_REQUEST')
  ) {
    return {
      tool: {
        name: 'subagent',
        arguments: {
          agent: 'probe-reviewer',
          description: 'scope child',
          prompt: 'Return CHILD_SCOPE_OK',
        },
      },
    };
  }
  return { text: sid === parentID ? 'PARENT_SCOPE_OK' : 'CHILD_SCOPE_OK' };
}

let host;
let proc;
let trace;
const traces = [];
const raw = { at: new Date().toISOString(), observations: {}, restarts: [], traces };
let output = '';
async function restart(kind) {
  const oldPID = proc.pid;
  if (kind === 'SIGKILL') {
    const stopped = once(proc, 'close');
    if (!proc.kill('SIGKILL'))
      throw new ProbeError('PROBE_KILL_FAILED', 'Cannot kill owned fixture server');
    await stopped;
  } else await stopProbeProcess(proc);
  releaseHold?.();
  if (trace) {
    await trace.stop();
    traces.push({ events: trace.events, failure: trace.failure, ended: trace.ended });
  }
  const artifact = await pinHost(host.artifact.path, host.project, host.env);
  if (artifact.sha256 !== host.artifact.sha256)
    throw new ProbeError('PROBE_BINARY_CHANGED', 'Host changed between restarts');
  proc = spawn(
    artifact.path,
    ['serve', '--hostname=127.0.0.1', `--port=${host.port}`, '--print-logs'],
    { cwd: host.project, env: host.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let spawnError;
  proc.on('error', (error) => {
    spawnError = error;
  });
  proc.stdout.on('data', (chunk) => {
    output += chunk;
  });
  proc.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const server = await waitForObservation(
    async () => {
      if (spawnError || !proc.pid || proc.exitCode !== null || proc.signalCode !== null)
        throw new ProbeError('PROBE_RESTART_FAILED', String(spawnError ?? 'Server exited'));
      try {
        return await host.client.server.info({ signal: AbortSignal.timeout(1_000) });
      } catch {
        return false;
      }
    },
    `${kind} restart`,
    90_000,
  );
  if (server.version !== '2.2.4' || server.pid !== proc.pid || server.pid === oldPID)
    throw new ProbeError('PROBE_RESTART_IDENTITY_MISMATCH', 'Not a new pinned owned server');
  // Create a known persisted session while no event subscriber is connected.
  const gapSession = await host.client.session.create({
    title: 'Disconnected event gap',
    location: { directory: host.project },
  });
  raw.restarts.push({ kind, oldPID, server, artifact, gapSession });
  trace = await startScopeTrace(host.client);
}

async function snapshots(sessions) {
  return Promise.all(
    sessions.map(async (session) => ({
      session: await host.client.session.get({ sessionID: session.id }),
      contextSha256: observationDigest(
        await host.client.session.context({ sessionID: session.id }),
      ),
      instructionsSha256: observationDigest(
        await host.client.experimental.session.instructions.entry.list({ sessionID: session.id }),
      ),
    })),
  );
}

async function attempt(input) {
  try {
    return { accepted: true, session: await host.client.session.create(input) };
  } catch (error) {
    return { accepted: false, error: { message: String(error), code: error.code } };
  }
}

try {
  host = await startProbeHost({ name: 'p0-02-h', script });
  proc = host.proc;
  raw.artifact = host.artifact;
  raw.initialServer = host.serverInfo;
  raw.discovery = host.discovery;
  raw.hostPaths = host.hostPaths;
  await host.activate();
  trace = await startScopeTrace(host.client);
  const worktree = join(host.root, 'other-worktree');
  const nested = join(host.project, 'nested');
  const alias = join(host.root, 'project-alias');
  await mkdir(nested);
  await symlink(host.project, alias, 'dir');
  const git = (...args) =>
    execFileSync('git', ['-C', host.project, ...args], {
      env: host.env,
      encoding: 'utf8',
      timeout: 30_000,
    }).trim();
  git('worktree', 'add', '--detach', worktree, 'HEAD');
  raw.git = {
    projectRoot: git('rev-parse', '--show-toplevel'),
    commonDir: git('rev-parse', '--git-common-dir'),
    worktrees: git('worktree', 'list', '--porcelain'),
  };
  raw.locations = {};
  const sessions = {};
  for (const [name, directory] of Object.entries({ root: host.project, worktree, nested, alias })) {
    raw.locations[name] = await host.client.location.get({ location: { directory } });
    sessions[name] = await host.client.session.create({
      title: `Scope ${name}`,
      location: { directory },
      model: { providerID: 'probe', id: 'probe', variant: 'chosen' },
    });
  }
  sessions.sibling = await host.session('Unrelated root sibling');
  raw.initialSessions = structuredClone(sessions);
  parentID = sessions.root.id;
  await host.client.experimental.session.instructions.entry.put({
    sessionID: parentID,
    key: 'probe-scope-sentinel',
    value: 'TEST_ONLY_NOT_GOVERNANCE',
  });
  await host.prompt(parentID, 'NATIVE_CHILD_REQUEST');
  await host.client.session.wait({ sessionID: parentID }, { signal: AbortSignal.timeout(30_000) });
  raw.parentContext = await host.client.session.context({ sessionID: parentID });
  raw.nativeChildReference = nativeChildReference(raw.parentContext);
  raw.observations.nativeChildReferenceCount = 1;
  sessions.child = await host.client.session.get({ sessionID: raw.nativeChildReference.sessionID });
  raw.childContext = await host.client.session.context({ sessionID: sessions.child.id });
  await waitForObservation(
    () => correlatedNativeChild(sessions.root, sessions.child, raw.parentContext, trace.events),
    'exact native tool/child/live-event correlation',
  );
  raw.observations.nativeChildCorrelated = true;
  raw.observations.nativeParentNormalAnswer = normalAnswer(raw.parentContext, 'PARENT_SCOPE_OK');
  raw.observations.nativeChildNormalAnswer = normalAnswer(raw.childContext, 'CHILD_SCOPE_OK');
  raw.instructions = {};
  for (const [name, session] of Object.entries(sessions))
    raw.instructions[name] = await host.client.experimental.session.instructions.entry.list({
      sessionID: session.id,
    });

  // Input-controlled parentage is tested only after the native-child observation.
  raw.sdkParentClaim = await attempt({
    title: 'SDK claimed child',
    parentID,
    agent: 'probe-reviewer',
    location: { directory: host.project },
  });
  const sacrificial = await host.session('Parent removed before claim');
  await host.client.session.remove({ sessionID: sacrificial.id });
  raw.deletedParentClaim = await attempt({
    title: 'SDK deleted-parent claim',
    parentID: sacrificial.id,
    location: { directory: worktree },
  });
  const collisionTarget = await host.session('ID collision target');
  raw.idCollision = {
    before: collisionTarget,
    attempt: await attempt({
      id: collisionTarget.id,
      parentID,
      title: 'Collision replacement',
      location: { directory: worktree },
    }),
    after: await host.client.session.get({ sessionID: collisionTarget.id }),
  };
  const raceID = `ses_scope_race_${randomBytes(12).toString('hex')}`;
  raw.concurrentCreate = {
    id: raceID,
    attempts: await Promise.all([
      attempt({
        id: raceID,
        title: 'Concurrent root',
        parentID,
        location: { directory: host.project },
      }),
      attempt({
        id: raceID,
        title: 'Concurrent worktree',
        parentID: sessions.sibling.id,
        location: { directory: worktree },
      }),
    ]),
  };
  try {
    raw.concurrentCreate.persisted = await host.client.session.get({ sessionID: raceID });
  } catch (error) {
    raw.concurrentCreate.readError = String(error);
  }
  const mover = await host.session('Movable fixture session');
  raw.move = { before: mover };
  await host.client.session.move({ sessionID: mover.id, directory: worktree });
  await host.client.session.wait({ sessionID: mover.id }, { signal: AbortSignal.timeout(30_000) });
  raw.move.after = await host.client.session.get({ sessionID: mover.id });
  raw.move.context = await host.client.session.context({ sessionID: mover.id });
  raw.move.siblingAfter = await host.client.session.get({ sessionID: sessions.sibling.id });

  const persisted = Object.values(sessions);
  raw.beforeGraceful = await snapshots(persisted);
  await restart('SIGTERM');
  raw.afterGraceful = await snapshots(persisted);
  raw.observations.gracefulSnapshotsEqual = stableSnapshots(raw.beforeGraceful, raw.afterGraceful);
  const crashing = await host.session('In-flight crash fixture');
  await host.prompt(crashing.id, 'HOLD_FOR_CRASH');
  await waitForObservation(() => holdSeen, 'provider received in-flight crash request');
  raw.crashBefore = await host.client.session.get({ sessionID: crashing.id });
  await restart('SIGKILL');
  raw.crashAfter = await host.client.session.get({ sessionID: crashing.id });
  raw.crashContextAfter = await host.client.session.context({ sessionID: crashing.id });
  try {
    await host.client.session.wait(
      { sessionID: crashing.id },
      { signal: AbortSignal.timeout(3_000) },
    );
    raw.crashWait = { returned: true };
  } catch (error) {
    raw.crashWait = { returned: false, error: String(error) };
  }
  raw.crashAfterWait = await host.client.session.get({ sessionID: crashing.id });
  raw.crashContextAfterWait = await host.client.session.context({ sessionID: crashing.id });
  raw.afterCrash = await snapshots(persisted);
  raw.observations.crashIdleSnapshotsEqual = stableSnapshots(raw.afterGraceful, raw.afterCrash);
  raw.observations.crashedBindingUnchanged = unchangedBinding(raw.crashBefore, raw.crashAfter);
  raw.observations.noLateAnswerMinted = !normalAnswer(raw.crashContextAfter, 'LATE_AFTER_CRASH');
  await host.prompt(sessions.sibling.id, 'POST_RESTART_CONTROL');
  await host.client.session.wait(
    { sessionID: sessions.sibling.id },
    { signal: AbortSignal.timeout(30_000) },
  );
  raw.postRestartContext = await host.client.session.context({ sessionID: sessions.sibling.id });
  raw.observations.postRestartNormalAnswer = normalAnswer(raw.postRestartContext, 'CHILD_SCOPE_OK');
  raw.finalSessions = await snapshots(persisted);
  raw.providerRequests = host.provider.requests;
  raw.childWireRequests = raw.providerRequests.filter(
    (request) => request.headers?.['x-opencode-session-id'] === sessions.child.id,
  );
  raw.journal = await host.entries();
} catch (error) {
  raw.error = { code: error.code, message: String(error), stack: error.stack };
} finally {
  releaseHold?.();
  const errors = [];
  try {
    if (trace) {
      await trace.stop();
      traces.push({ events: trace.events, failure: trace.failure, ended: trace.ended });
    }
  } catch (error) {
    errors.push(String(error));
  }
  try {
    await stopProbeProcess(proc);
  } catch (error) {
    errors.push(String(error));
  }
  try {
    if (host) await host.close();
  } catch (error) {
    errors.push(String(error));
  }
  raw.cleanup = { completed: errors.length === 0, errors };
  raw.output = output;
}

await writeFile(join(runDir, 'raw.json'), JSON.stringify(raw, null, 2) + '\n');
const report = {
  at: raw.at,
  surface: 'macOS private CLI/server 2.2.4; deterministic local provider',
  artifact: raw.artifact,
  p002H: 'NOT_VERIFIED',
  operatorAuthority: 'BLOCKED',
  productImplementation: 'NO-GO',
  observations: raw.observations,
  scopeMapping:
    raw.locations?.root && raw.locations?.worktree && raw.locations?.alias
      ? {
          rootAndWorktreeShareProjectID:
            raw.locations.root.project.id === raw.locations.worktree.project.id,
          worktreeDirectoriesDistinct:
            raw.locations.root.project.directory !== raw.locations.worktree.project.directory,
          aliasLocationIsRawAlias:
            raw.locations.alias.directory !== raw.locations.alias.project.directory,
          nativeChildHasRootInstructionEntry:
            raw.instructions?.child.some((entry) => entry.key === 'probe-scope-sentinel') ?? null,
          nativeChildWireRequestCount: raw.childWireRequests?.length ?? null,
          nativeChildWireHasRootSentinel: raw.childWireRequests?.length
            ? raw.childWireRequests.some((request) =>
                JSON.stringify(request.body).includes('TEST_ONLY_NOT_GOVERNANCE'),
              )
            : null,
        }
      : null,
  error: raw.error,
  cleanup: raw.cleanup,
  sdkParentClaimAccepted: raw.sdkParentClaim?.accepted,
  deletedParentClaimAccepted: raw.deletedParentClaim?.accepted,
  idCollision: {
    accepted: raw.idCollision?.attempt.accepted,
    bindingPreserved: raw.idCollision
      ? unchangedBinding(raw.idCollision.before, raw.idCollision.after)
      : null,
    fullSessionPreserved: raw.idCollision
      ? observationDigest(raw.idCollision.before) === observationDigest(raw.idCollision.after)
      : null,
  },
  concurrentCreate: {
    admitted: raw.concurrentCreate?.attempts.filter((attempt) => attempt.accepted).length,
    returnedBindings: raw.concurrentCreate?.attempts
      .filter((attempt) => attempt.accepted)
      .map((attempt) => sessionBinding(attempt.session)),
    persisted: raw.concurrentCreate?.persisted
      ? sessionBinding(raw.concurrentCreate.persisted)
      : null,
    readError: raw.concurrentCreate?.readError,
  },
  crashedSession: {
    waitReturned: raw.crashWait?.returned,
    outcomeAfterWait: raw.crashAfterWait?.outcome ?? null,
    busyTimestampRetained: raw.crashAfterWait ? !!raw.crashAfterWait.time?.busy : null,
    lateAnswerAfterWait: raw.crashContextAfterWait
      ? normalAnswer(raw.crashContextAfterWait, 'LATE_AFTER_CRASH')
      : null,
  },
  eventStreams: traces.map((trace) => ({
    events: trace.events.length,
    failure: trace.failure ?? null,
    ended: trace.ended,
  })),
  disconnectedGapSessionCreatedEventsObserved: raw.restarts.map(
    (restart) =>
      traces
        .flatMap((trace) => trace.events)
        .filter(
          (event) =>
            event.type === 'session.created' && event.data?.sessionID === restart.gapSession.id,
        ).length,
  ),
  sdkParentFieldAloneAsNativeProvenance:
    raw.sdkParentClaim?.accepted &&
    raw.sdkParentClaim.session.parentID === raw.initialSessions.root.id
      ? 'NOT_SUPPORTED'
      : 'NOT_VERIFIED',
  sourceSha256: {},
};
for (const path of [
  'lib/host.mjs',
  'lib/isolation.mjs',
  'lib/provider.mjs',
  'lib/scope-evidence.mjs',
  'plugin/flowguard-probe.js',
  'probes/p0-scope-lifecycle.mjs',
])
  report.sourceSha256[path] = createHash('sha256')
    .update(await readFile(new URL(`../${path}`, import.meta.url)))
    .digest('hex');
await writeFile(join(runDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ runDir, ...report }, null, 2));
if (raw.error || !raw.cleanup.completed) process.exitCode = 1;

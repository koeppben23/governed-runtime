/**
 * @module adapters/diagnostics/export.test
 * @description Read-only diagnostic snapshot contract and negative paths.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createTestWorkspace, type TestWorkspace } from '../../integration/test-helpers.js';
import { initWorkspace } from '../workspace/index.js';
import { writeState } from '../persistence.js';
import { appendAuditEvent } from '../persistence-audit.js';
import { BINDING, PLAN_REVIEW_ASSURANCE, makeState } from '../../fixtures.js';
import {
  messageCaptureFixture,
  nativeProvenanceFixture,
} from '../../review-invocation-test-helpers.js';
import { writeDiagnosticExport, type DiagnosticExportRequest } from './export.js';
import type { HostTranscript } from './host-transcript.js';

const ROOT_ID = 'ses_root';
const ROOT_STATE_ID = '00000000-0000-4000-8000-000000000101';
const CHILD_STATE_ID = '00000000-0000-4000-8000-000000000102';
const CHILD_ID = 'child-session-1';
const GRANDCHILD_STATE_ID = '00000000-0000-4000-8000-000000000103';
const GRANDCHILD_ID = 'grandchild-session-1';
const FIXED_NOW = () => new Date('2026-01-01T00:00:00.000Z');
const CAPTURE_ID = '00000000-0000-4000-8000-000000000099';

let ws: TestWorkspace;

beforeEach(async () => {
  ws = await createTestWorkspace();
});
afterEach(async () => {
  await ws.cleanup();
});

function boundState(
  stateId: string,
  hostSessionId: string,
  fingerprint: string,
  overrides: Record<string, unknown> = {},
) {
  return makeState('READY', {
    id: stateId,
    flowguardSessionId: stateId,
    binding: { ...BINDING, hostSessionId, worktree: ws.tmpDir, fingerprint },
    ...overrides,
  });
}

function hostTranscript(sessionId: string): HostTranscript {
  const payload = {
    info: { id: sessionId, time: { created: 1 } },
    messages: [
      {
        info: { id: 'msg_1', sessionID: sessionId, role: 'user', time: { created: 1 } },
        parts: [
          {
            id: 'part_1',
            sessionID: sessionId,
            messageID: 'msg_1',
            type: 'text',
            text: 'SECRET_PROMPT_MUST_NOT_LEAK',
          },
        ],
      },
    ],
  };
  return { sessionId, payload, messageCount: 1, bytes: JSON.stringify(payload).length };
}

async function writeFlowGuardLog(
  entries: readonly Record<string, unknown>[],
  file = 'flowguard-2026-01-01.log',
): Promise<void> {
  const directory = path.join(ws.tmpDir, '.opencode', 'logs');
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, file),
    `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
  );
}

function logEntry(sessionId: string, overrides: Record<string, unknown> = {}) {
  return {
    ts: '2026-01-01T00:00:00.000Z',
    level: 'info',
    service: 'flowguard',
    sessionId,
    traceId: `trace-${sessionId}`,
    message: 'diagnostic entry',
    fields: { phase: 'READY' },
    ...overrides,
  };
}

function request(
  outputDir: string,
  overrides: Partial<DiagnosticExportRequest> = {},
): DiagnosticExportRequest {
  return {
    root: ws.tmpDir,
    sessionId: ROOT_ID,
    outputDir,
    redactionMode: 'basic' as const,
    includeHost: false,
    logsDirectory: path.join(ws.tmpDir, '.opencode', 'logs'),
    logsDirectoryLabel: '.opencode/logs',
    now: FIXED_NOW,
    captureId: CAPTURE_ID,
    limits: {
      maxSessions: 10,
      maxFileBytes: 1_000_000,
      maxTotalBytes: 10_000_000,
      hostTimeoutMs: 1_000,
      maxDurationMs: 60_000,
    },
    ...overrides,
  };
}

function rootLinkedAssurance(): typeof PLAN_REVIEW_ASSURANCE {
  return {
    ...PLAN_REVIEW_ASSURANCE,
    invocations: PLAN_REVIEW_ASSURANCE.invocations.map((invocation) => ({
      ...invocation,
      parentSessionId: ROOT_ID,
    })),
  };
}

function linkedAssurance(
  parentSessionId: string,
  childSessionId: string,
): typeof PLAN_REVIEW_ASSURANCE {
  const invocationId = randomUUID();
  const attemptId = randomUUID();
  const obligationId = PLAN_REVIEW_ASSURANCE.obligations[0]?.obligationId ?? '';
  const capture = messageCaptureFixture({ childSessionId, obligationId, attemptId });
  return {
    ...PLAN_REVIEW_ASSURANCE,
    obligations: PLAN_REVIEW_ASSURANCE.obligations.map((obligation) => ({
      ...obligation,
      invocationId,
    })),
    invocations: [
      {
        ...PLAN_REVIEW_ASSURANCE.invocations[0]!,
        invocationId,
        attemptId,
        parentSessionId,
        childSessionId,
        capture,
        nativeProvenance: nativeProvenanceFixture(capture, childSessionId),
      },
    ],
    attempts: [{ ...PLAN_REVIEW_ASSURANCE.attempts[0]!, attemptId, childSessionId }],
    dispatches: [
      {
        ...PLAN_REVIEW_ASSURANCE.dispatches[0]!,
        dispatchId: randomUUID(),
        attemptId,
        hostCallId: childSessionId,
      },
    ],
  };
}

async function writeReviewerState(
  sessionId: string,
  stateId: string,
  fingerprint: string,
  assurance?: typeof PLAN_REVIEW_ASSURANCE,
): Promise<string> {
  const { sessionDir } = await initWorkspace(ws.tmpDir, sessionId);
  await writeState(
    sessionDir,
    boundState(
      stateId,
      sessionId,
      fingerprint,
      assurance === undefined ? {} : { reviewAssurance: assurance },
    ),
  );
  return sessionDir;
}

async function rootState(
  assurance?: typeof PLAN_REVIEW_ASSURANCE,
): Promise<{ sessionDir: string; fingerprint: string }> {
  const { sessionDir, fingerprint } = await initWorkspace(ws.tmpDir, ROOT_ID);
  const state = boundState(
    ROOT_STATE_ID,
    ROOT_ID,
    fingerprint,
    assurance === undefined ? {} : { reviewAssurance: assurance },
  );
  await writeState(sessionDir, state);
  return { sessionDir, fingerprint };
}

describe('diagnostic export', () => {
  describe('HAPPY — bounded snapshot with manifest and session graph', () => {
    it('writes a complete manifest, graph and state without modifying canonical state', async () => {
      const { sessionDir } = await rootState();
      await writeFlowGuardLog([logEntry(ROOT_ID)]);
      const before = await readFile(path.join(sessionDir, 'session-state.json'), 'utf8');
      const outputDir = path.join(ws.tmpDir, 'diag-complete');

      const result = await writeDiagnosticExport(request(outputDir));

      expect(result.manifest.status).toBe('COMPLETE');
      expect(result.manifest.boundary.sessionsKnown).toBe(1);
      expect(result.manifest.boundary.sessionsWithState).toBe(1);
      expect(result.manifest.counts.hostMessages).toBe(0);
      expect(result.manifest.counts.logEntries).toBe(1);
      const manifest = JSON.parse(await readFile(path.join(outputDir, 'manifest.json'), 'utf8'));
      expect(manifest.captureId).toBe(CAPTURE_ID);
      expect(manifest.files.map((file: { path: string }) => file.path)).toEqual(
        expect.arrayContaining([
          'session-graph.json',
          'timeline.json',
          'diagnostics/log-files.json',
          'diagnostics/logs.redacted.jsonl',
          'sessions/ses_root/state.redacted.json',
        ]),
      );
      const graph = JSON.parse(await readFile(path.join(outputDir, 'session-graph.json'), 'utf8'));
      expect(graph.rootSessionId).toBe(ROOT_ID);
      expect(graph.sessions).toHaveLength(1);
      expect(manifest.sources.logs).toMatchObject({
        status: 'complete',
        entriesIncluded: 1,
        parseErrors: 0,
        hostLogs: { status: 'not_verified' },
      });
      const logArtifact = await readFile(
        path.join(outputDir, 'diagnostics', 'logs.redacted.jsonl'),
        'utf8',
      );
      expect(logArtifact).toContain('diagnostic entry');
      expect(logArtifact).toContain(ROOT_ID);
      const logIndex = JSON.parse(
        await readFile(path.join(outputDir, 'diagnostics', 'log-files.json'), 'utf8'),
      );
      expect(logIndex.artifact).toBe('diagnostics/logs.redacted.jsonl');
      expect(logIndex.files).toHaveLength(1);
      expect(await readFile(path.join(sessionDir, 'session-state.json'), 'utf8')).toBe(before);
    });

    it('reports malformed log input as an explicit source gap', async () => {
      await rootState();
      const logDirectory = path.join(ws.tmpDir, '.opencode', 'logs');
      await mkdir(logDirectory, { recursive: true });
      await writeFile(
        path.join(logDirectory, 'flowguard-2026-01-01.log'),
        `${JSON.stringify(logEntry(ROOT_ID))}\nnot-json\n`,
      );
      const outputDir = path.join(ws.tmpDir, 'diag-log-gap');

      const result = await writeDiagnosticExport(request(outputDir));
      expect(result.manifest.status).toBe('PARTIAL');
      expect(result.manifest.sources.logs).toMatchObject({
        status: 'partial',
        parseErrors: 1,
        entriesIncluded: 1,
      });
      expect(result.manifest.warnings).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'LOG_CAPTURE_PARTIAL' })]),
      );
    });

    it('captures a known reviewer child and preserves technical IDs while masking host text', async () => {
      await rootState(rootLinkedAssurance());
      await writeFlowGuardLog([logEntry(ROOT_ID), logEntry(CHILD_ID)]);
      const outputDir = path.join(ws.tmpDir, 'diag-host');

      const hostTimeouts: number[] = [];
      const result = await writeDiagnosticExport(
        request(outputDir, {
          includeHost: true,
          hostReader: async (sessionId, timeoutMs) => {
            hostTimeouts.push(timeoutMs);
            return hostTranscript(sessionId);
          },
        }),
      );

      expect(hostTimeouts.length).toBe(2);
      expect(hostTimeouts.every((timeout) => timeout <= 1_000)).toBe(true);
      expect(result.manifest.boundary.sessionsKnown).toBe(2);
      expect(result.manifest.boundary.sessionsWithoutState).toBe(1);
      expect(result.manifest.counts.hostMessages).toBe(2);
      expect(result.manifest.status).toBe('PARTIAL');
      expect(result.manifest.sources).toMatchObject({
        lineage: { status: 'complete' },
        canonicalState: { status: 'partial' },
        hostHistory: { status: 'complete' },
        logs: { status: 'complete', sessionsWithoutEntries: [] },
      });
      const graph = JSON.parse(await readFile(path.join(outputDir, 'session-graph.json'), 'utf8'));
      expect(graph.sessions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionId: CHILD_ID,
            parentSessionId: ROOT_ID,
            role: 'reviewer',
            lineage: 'verified',
            state: 'absent',
            hostHistory: 'captured',
          }),
        ]),
      );
      const host = await readFile(
        path.join(outputDir, 'sessions', CHILD_ID, 'host.transcript.redacted.json'),
        'utf8',
      );
      expect(host).toContain('part_1');
      expect(host).toContain('msg_1');
      expect(host).not.toContain('SECRET_PROMPT_MUST_NOT_LEAK');
      expect(host).toContain('[REDACTED]');
    });
  });

  it('does not read a child whose invocation parent is not the requested root', async () => {
    await rootState(PLAN_REVIEW_ASSURANCE);
    await writeFlowGuardLog([logEntry(ROOT_ID)]);
    const outputDir = path.join(ws.tmpDir, 'diag-foreign-parent');

    const result = await writeDiagnosticExport(
      request(outputDir, {
        includeHost: true,
        hostReader: async (sessionId) => hostTranscript(sessionId),
      }),
    );

    expect(result.manifest.status).toBe('PARTIAL');
    expect(result.manifest.boundary.sessionsLineageUnverified).toBe(1);
    expect(result.manifest.sources.lineage.status).toBe('partial');
    expect(result.manifest.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'SESSION_LINEAGE_NOT_VERIFIED',
          sessionId: CHILD_ID,
        }),
      ]),
    );
    const graph = JSON.parse(await readFile(path.join(outputDir, 'session-graph.json'), 'utf8'));
    expect(graph.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: CHILD_ID,
          lineage: 'not_verified',
          state: 'unavailable',
          binding: 'unknown',
          hostHistory: 'not_requested',
        }),
      ]),
    );
    await expect(
      readFile(path.join(outputDir, 'sessions', CHILD_ID, 'host.transcript.redacted.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('captures a verified root → child → grandchild invocation chain', async () => {
    const { fingerprint } = await rootState(rootLinkedAssurance());
    await writeReviewerState(
      CHILD_ID,
      CHILD_STATE_ID,
      fingerprint,
      linkedAssurance(CHILD_ID, GRANDCHILD_ID),
    );
    await writeReviewerState(GRANDCHILD_ID, GRANDCHILD_STATE_ID, fingerprint);
    await writeFlowGuardLog([logEntry(ROOT_ID), logEntry(CHILD_ID), logEntry(GRANDCHILD_ID)]);
    const outputDir = path.join(ws.tmpDir, 'diag-multilevel');

    const result = await writeDiagnosticExport(request(outputDir));

    expect(result.manifest.status).toBe('COMPLETE');
    expect(result.manifest.boundary.sessionsKnown).toBe(3);
    expect(result.manifest.boundary.sessionsWithState).toBe(3);
    expect(result.manifest.sources).toMatchObject({
      discovery: { status: 'complete', known: 3, verified: 3, unverified: 0 },
      lineage: { status: 'complete', verified: 3, unverified: 0 },
    });
    const graph = JSON.parse(await readFile(path.join(outputDir, 'session-graph.json'), 'utf8'));
    expect(graph.sessions).toEqual([
      expect.objectContaining({ sessionId: ROOT_ID, generation: 0, lineage: 'verified' }),
      expect.objectContaining({
        sessionId: CHILD_ID,
        parentSessionId: ROOT_ID,
        generation: 1,
        lineage: 'verified',
      }),
      expect.objectContaining({
        sessionId: GRANDCHILD_ID,
        parentSessionId: CHILD_ID,
        generation: 2,
        lineage: 'verified',
      }),
    ]);
    expect(result.manifest.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        `sessions/${CHILD_ID}/state.redacted.json`,
        `sessions/${GRANDCHILD_ID}/state.redacted.json`,
      ]),
    );
  });

  it('keeps a known grandchild in the denominator when maxSessions is reached', async () => {
    const { fingerprint } = await rootState(rootLinkedAssurance());
    await writeReviewerState(
      CHILD_ID,
      CHILD_STATE_ID,
      fingerprint,
      linkedAssurance(CHILD_ID, GRANDCHILD_ID),
    );
    await writeReviewerState(GRANDCHILD_ID, GRANDCHILD_STATE_ID, fingerprint);
    const outputDir = path.join(ws.tmpDir, 'diag-max-sessions');

    const result = await writeDiagnosticExport(
      request(outputDir, {
        limits: {
          maxSessions: 2,
          maxFileBytes: 1_000_000,
          maxTotalBytes: 10_000_000,
          hostTimeoutMs: 1_000,
          maxDurationMs: 60_000,
        },
      }),
    );

    expect(result.manifest.status).toBe('PARTIAL');
    expect(result.manifest.boundary.sessionsKnown).toBe(3);
    expect(result.manifest.boundary.sessionsWithState).toBe(2);
    expect(result.manifest.sources.discovery).toMatchObject({
      status: 'complete',
      known: 3,
      truncated: false,
    });
    const graph = JSON.parse(await readFile(path.join(outputDir, 'session-graph.json'), 'utf8'));
    expect(graph.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: GRANDCHILD_ID,
          parentSessionId: CHILD_ID,
          generation: 2,
          captureStatus: 'truncated',
          lineage: 'verified',
        }),
      ]),
    );
    expect(result.manifest.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'SESSION_LIMIT_TRUNCATED', sessionId: GRANDCHILD_ID }),
      ]),
    );
    await expect(
      readFile(path.join(outputDir, 'sessions', GRANDCHILD_ID, 'state.redacted.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('stops discovery at the hard node budget and reports the truncation', async () => {
    const { fingerprint } = await rootState(rootLinkedAssurance());
    await writeReviewerState(
      CHILD_ID,
      CHILD_STATE_ID,
      fingerprint,
      linkedAssurance(CHILD_ID, GRANDCHILD_ID),
    );
    await writeReviewerState(GRANDCHILD_ID, GRANDCHILD_STATE_ID, fingerprint);
    const outputDir = path.join(ws.tmpDir, 'diag-discovery-budget');

    const result = await writeDiagnosticExport(
      request(outputDir, {
        limits: {
          maxSessions: 10,
          maxDiscoveryNodes: 2,
          maxFileBytes: 1_000_000,
          maxTotalBytes: 10_000_000,
          hostTimeoutMs: 1_000,
          maxDurationMs: 60_000,
        },
      }),
    );

    expect(result.manifest.status).toBe('PARTIAL');
    expect(result.manifest.boundary.maxDiscoveryNodes).toBe(2);
    expect(result.manifest.boundary.sessionsKnown).toBe(3);
    expect(result.manifest.boundary.sessionsWithState).toBe(2);
    expect(result.manifest.sources.discovery).toMatchObject({
      status: 'partial',
      known: 3,
      truncated: true,
    });
    expect(result.manifest.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'DISCOVERY_TRUNCATED' })]),
    );
    const graph = JSON.parse(await readFile(path.join(outputDir, 'session-graph.json'), 'utf8'));
    expect(graph.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: GRANDCHILD_ID,
          parentSessionId: CHILD_ID,
          captureStatus: 'truncated',
          lineage: 'verified',
        }),
      ]),
    );
    await expect(
      readFile(path.join(outputDir, 'sessions', GRANDCHILD_ID, 'state.redacted.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps known descendants in the denominator after the time budget expires', async () => {
    const { fingerprint } = await rootState(rootLinkedAssurance());
    await writeReviewerState(CHILD_ID, CHILD_STATE_ID, fingerprint);
    const outputDir = path.join(ws.tmpDir, 'diag-time-budget');
    let current = Date.parse('2026-01-01T00:00:00.000Z');
    const advancingClock = () => {
      const value = new Date(current);
      current += 10_000;
      return value;
    };

    const result = await writeDiagnosticExport(
      request(outputDir, {
        now: advancingClock,
        limits: {
          maxSessions: 10,
          maxFileBytes: 1_000_000,
          maxTotalBytes: 10_000_000,
          hostTimeoutMs: 1_000,
          maxDurationMs: 5_000,
        },
      }),
    );

    expect(result.manifest.status).toBe('PARTIAL');
    expect(result.manifest.boundary.sessionsKnown).toBe(2);
    expect(result.manifest.boundary.sessionsWithState).toBe(1);
    expect(result.manifest.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'CAPTURE_TIME_BUDGET_EXCEEDED',
          sessionId: CHILD_ID,
        }),
      ]),
    );
    const graph = JSON.parse(await readFile(path.join(outputDir, 'session-graph.json'), 'utf8'));
    expect(graph.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: CHILD_ID,
          captureStatus: 'truncated',
          lineage: 'verified',
          state: 'unavailable',
        }),
      ]),
    );
    await expect(
      readFile(path.join(outputDir, 'sessions', CHILD_ID, 'state.redacted.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  describe('BAD — known unavailable sessions are never dropped', () => {
    it('reports PARTIAL when a known child has a mismatched binding', async () => {
      const { fingerprint } = await rootState(rootLinkedAssurance());
      const { sessionDir: childDir } = await initWorkspace(ws.tmpDir, CHILD_ID);
      await writeState(
        childDir,
        makeState('READY', {
          id: CHILD_STATE_ID,
          flowguardSessionId: CHILD_STATE_ID,
          binding: {
            ...BINDING,
            hostSessionId: CHILD_ID,
            worktree: '/tmp/foreign-worktree',
            fingerprint,
          },
        }),
      );
      const outputDir = path.join(ws.tmpDir, 'diag-partial');

      const result = await writeDiagnosticExport(request(outputDir));

      expect(result.manifest.status).toBe('PARTIAL');
      expect(result.manifest.boundary.sessionsKnown).toBe(2);
      expect(result.manifest.boundary.sessionsUnavailable).toBe(1);
      expect(result.manifest.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'SESSION_WORKTREE_MISMATCH', sessionId: CHILD_ID }),
        ]),
      );
      const graph = JSON.parse(await readFile(path.join(outputDir, 'session-graph.json'), 'utf8'));
      expect(graph.sessions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sessionId: CHILD_ID, state: 'unavailable' }),
        ]),
      );
    });
  });

  describe('RESOURCE — every source is bounded', () => {
    it('does not read an audit trail above the per-file budget', async () => {
      const { sessionDir } = await rootState();
      await appendAuditEvent(sessionDir, {
        id: randomUUID(),
        flowguardSessionId: ROOT_STATE_ID,
        hostSessionId: ROOT_ID,
        phase: 'READY',
        event: 'test:padding',
        occurredAt: '2026-01-01T00:00:00.000Z',
        actor: 'machine',
        detail: { padding: 'x'.repeat(30_000) },
      });
      const outputDir = path.join(ws.tmpDir, 'diag-audit-limit');

      const result = await writeDiagnosticExport(
        request(outputDir, {
          limits: {
            maxSessions: 10,
            maxFileBytes: 20_000,
            maxTotalBytes: 10_000_000,
            hostTimeoutMs: 1_000,
            maxDurationMs: 60_000,
          },
        }),
      );

      expect(result.manifest.status).toBe('PARTIAL');
      expect(result.manifest.warnings).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'AUDIT_TOO_LARGE' })]),
      );
    });

    it('does not persist a host transcript above the per-file budget', async () => {
      await rootState();
      const outputDir = path.join(ws.tmpDir, 'diag-host-limit');

      const result = await writeDiagnosticExport(
        request(outputDir, {
          includeHost: true,
          limits: {
            maxSessions: 10,
            maxFileBytes: 20_000,
            maxTotalBytes: 10_000_000,
            hostTimeoutMs: 1_000,
            maxDurationMs: 60_000,
          },
          hostReader: async (sessionId) => ({ ...hostTranscript(sessionId), bytes: 30_000 }),
        }),
      );

      expect(result.manifest.status).toBe('PARTIAL');
      expect(result.manifest.warnings).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'HOST_HISTORY_TOO_LARGE' })]),
      );
      await expect(
        readFile(
          path.join(outputDir, 'sessions', ROOT_ID, 'host.transcript.redacted.json'),
          'utf8',
        ),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('marks the log source partial when the log artifact cannot be published', async () => {
      await rootState();
      await writeFlowGuardLog([
        logEntry(ROOT_ID, { message: 'x'.repeat(50_000), traceId: 'trace-artifact' }),
      ]);
      const outputDir = path.join(ws.tmpDir, 'diag-log-artifact-limit');

      const result = await writeDiagnosticExport(
        request(outputDir, {
          limits: {
            maxSessions: 10,
            maxFileBytes: 20_000,
            maxTotalBytes: 10_000_000,
            hostTimeoutMs: 1_000,
            maxDurationMs: 60_000,
          },
        }),
      );

      expect(result.manifest.status).toBe('PARTIAL');
      expect(result.manifest.sources.logs.status).toBe('partial');
      expect(result.manifest.warnings).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'LOG_ARTIFACT_TOO_LARGE' })]),
      );
      const index = JSON.parse(
        await readFile(path.join(outputDir, 'diagnostics', 'log-files.json'), 'utf8'),
      );
      expect(index.artifact).toBeNull();
      expect(index.status).toBe('PARTIAL');
    });

    it('reports an explicit artifact-limit warning instead of silently truncating', async () => {
      await rootState();
      const outputDir = path.join(ws.tmpDir, 'diag-total-limit');

      const result = await writeDiagnosticExport(
        request(outputDir, {
          limits: {
            maxSessions: 10,
            maxFileBytes: 20_000,
            maxTotalBytes: 500,
            hostTimeoutMs: 1_000,
            maxDurationMs: 60_000,
          },
        }),
      );

      expect(result.manifest.status).toBe('PARTIAL');
      expect(result.manifest.warnings).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'ARTIFACT_TOO_LARGE' })]),
      );
      expect(result.manifest.sources.canonicalState.status).toBe('complete');
    });
  });

  describe('CORNER — output is write-once and host failures are explicit', () => {
    it('refuses to overwrite an existing diagnostic directory', async () => {
      await rootState();
      const outputDir = path.join(ws.tmpDir, 'diag-existing');
      await mkdir(outputDir);

      await expect(writeDiagnosticExport(request(outputDir))).rejects.toMatchObject({
        code: 'OUTPUT_EXISTS',
      });
    });

    it('records a host capture failure instead of fabricating a transcript', async () => {
      await rootState(rootLinkedAssurance());
      const outputDir = path.join(ws.tmpDir, 'diag-host-failure');

      const result = await writeDiagnosticExport(
        request(outputDir, {
          includeHost: true,
          hostReader: async () => {
            throw new Error('host unavailable at /private/secret/token=abcdef');
          },
        }),
      );

      expect(result.manifest.status).toBe('PARTIAL');
      expect(result.manifest.boundary.hostHistory).toBe('unavailable');
      expect(result.manifest.warnings).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'HOST_HISTORY_UNAVAILABLE' })]),
      );
      const serialized = JSON.stringify(result.manifest);
      expect(serialized).not.toContain('/private/secret');
      expect(serialized).not.toContain('token=abcdef');
      await expect(
        readFile(
          path.join(outputDir, 'sessions', ROOT_ID, 'host.transcript.redacted.json'),
          'utf8',
        ),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  describe('EDGE — raw is explicit and typed failures stay typed', () => {
    it('requires an explicit raw mode and does not redact when chosen', async () => {
      await rootState();
      const outputDir = path.join(ws.tmpDir, 'diag-raw');

      const result = await writeDiagnosticExport(
        request(outputDir, {
          redactionMode: 'none',
          includeHost: true,
          hostReader: async (id) => hostTranscript(id),
        }),
      );

      expect(result.manifest.redaction.rawIncluded).toBe(true);
      const host = await readFile(
        path.join(outputDir, 'sessions', ROOT_ID, 'host.transcript.json'),
        'utf8',
      );
      expect(host).toContain('SECRET_PROMPT_MUST_NOT_LEAK');
    });

    it('rejects an invalid session id through the canonical workspace validator', async () => {
      await expect(
        writeDiagnosticExport(
          request(path.join(ws.tmpDir, 'diag-invalid'), { sessionId: '../escape' }),
        ),
      ).rejects.toBeTruthy();
    });
  });
});

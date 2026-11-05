/**
 * @module adapters/diagnostics/export.test
 * @description Read-only diagnostic snapshot contract and negative paths.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createTestWorkspace, type TestWorkspace } from '../../integration/test-helpers.js';
import { initWorkspace } from '../workspace/index.js';
import { writeState } from '../persistence.js';
import { BINDING, PLAN_REVIEW_ASSURANCE, makeState } from '../../fixtures.js';
import { writeDiagnosticExport, type DiagnosticExportRequest } from './export.js';
import type { HostTranscript } from './host-transcript.js';

const ROOT_ID = 'ses_root';
const ROOT_STATE_ID = '00000000-0000-4000-8000-000000000101';
const CHILD_STATE_ID = '00000000-0000-4000-8000-000000000102';
const CHILD_ID = 'child-session-1';
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
    now: FIXED_NOW,
    captureId: CAPTURE_ID,
    limits: { maxSessions: 10, maxFileBytes: 1_000_000, hostTimeoutMs: 1_000 },
    ...overrides,
  };
}

async function rootState(
  withAssurance = false,
): Promise<{ sessionDir: string; fingerprint: string }> {
  const { sessionDir, fingerprint } = await initWorkspace(ws.tmpDir, ROOT_ID);
  const state = boundState(
    ROOT_STATE_ID,
    ROOT_ID,
    fingerprint,
    withAssurance ? { reviewAssurance: PLAN_REVIEW_ASSURANCE } : {},
  );
  await writeState(sessionDir, state);
  return { sessionDir, fingerprint };
}

describe('diagnostic export', () => {
  describe('HAPPY — bounded snapshot with manifest and session graph', () => {
    it('writes a complete manifest, graph and state without modifying canonical state', async () => {
      const { sessionDir } = await rootState();
      const before = await readFile(path.join(sessionDir, 'session-state.json'), 'utf8');
      const outputDir = path.join(ws.tmpDir, 'diag-complete');

      const result = await writeDiagnosticExport(request(outputDir));

      expect(result.manifest.status).toBe('COMPLETE');
      expect(result.manifest.boundary.sessionsKnown).toBe(1);
      expect(result.manifest.boundary.sessionsWithState).toBe(1);
      expect(result.manifest.counts.hostMessages).toBe(0);
      const manifest = JSON.parse(await readFile(path.join(outputDir, 'manifest.json'), 'utf8'));
      expect(manifest.captureId).toBe(CAPTURE_ID);
      expect(manifest.files.map((file: { path: string }) => file.path)).toEqual(
        expect.arrayContaining([
          'session-graph.json',
          'timeline.json',
          'sessions/ses_root/state.redacted.json',
        ]),
      );
      const graph = JSON.parse(await readFile(path.join(outputDir, 'session-graph.json'), 'utf8'));
      expect(graph.rootSessionId).toBe(ROOT_ID);
      expect(graph.sessions).toHaveLength(1);
      expect(await readFile(path.join(sessionDir, 'session-state.json'), 'utf8')).toBe(before);
    });

    it('captures a known reviewer child and preserves technical IDs while masking host text', async () => {
      await rootState(true);
      const outputDir = path.join(ws.tmpDir, 'diag-host');

      const result = await writeDiagnosticExport(
        request(outputDir, {
          includeHost: true,
          hostReader: async (sessionId) => hostTranscript(sessionId),
        }),
      );

      expect(result.manifest.boundary.sessionsKnown).toBe(2);
      expect(result.manifest.boundary.sessionsWithoutState).toBe(1);
      expect(result.manifest.counts.hostMessages).toBe(2);
      expect(result.manifest.status).toBe('COMPLETE');
      const graph = JSON.parse(await readFile(path.join(outputDir, 'session-graph.json'), 'utf8'));
      expect(graph.sessions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionId: CHILD_ID,
            parentSessionId: 'parent-session-1',
            role: 'reviewer',
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

  describe('BAD — known unavailable sessions are never dropped', () => {
    it('reports PARTIAL when a known child has a mismatched binding', async () => {
      const { fingerprint } = await rootState(true);
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
      await rootState(true);
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

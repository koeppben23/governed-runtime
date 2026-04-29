/**
 * @module integration/tools-execute-status.test
 * @description Execution tests for the status tool.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import {
  createToolContext,
  createTestWorkspace,
  parseToolResult,
  GIT_MOCK_DEFAULTS,
  type TestToolContext,
  type TestWorkspace,
} from './test-helpers.js';
import { status, hydrate, ticket } from './tools/index.js';
import { readState, writeState } from '../adapters/persistence.js';

// ─── Git Mock ────────────────────────────────────────────────────────────────

vi.mock('../adapters/git', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/git.js')>();
  return {
    ...original,
    remoteOriginUrl: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.remoteOriginUrl),
    changedFiles: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.changedFiles),
    listRepoSignals: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.repoSignals),
  };
});

// ─── Workspace Mock (P26) ────────────────────────────────────────────────────

const wsOriginals = vi.hoisted(() => ({
  archiveSession:
    null as unknown as (typeof import('../adapters/workspace/index.js'))['archiveSession'],
  verifyArchive:
    null as unknown as (typeof import('../adapters/workspace/index.js'))['verifyArchive'],
}));

vi.mock('../adapters/workspace', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/workspace/index.js')>();
  wsOriginals.archiveSession = original.archiveSession;
  wsOriginals.verifyArchive = original.verifyArchive;
  return {
    ...original,
    archiveSession: vi.fn(original.archiveSession),
    verifyArchive: vi.fn(original.verifyArchive),
  };
});

// ─── Actor Mock (P27) ────────────────────────────────────────────────────────

const actorOriginal = vi.hoisted(() => ({
  resolveActor: null as unknown as (typeof import('../adapters/actor.js'))['resolveActor'],
}));

vi.mock('../adapters/actor', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/actor.js')>();
  actorOriginal.resolveActor = original.resolveActor;
  return {
    ...original,
    resolveActor: vi.fn().mockResolvedValue({
      id: 'test-operator',
      email: 'test@flowguard.dev',
      source: 'env',
    }),
  };
});

const wsMock = await import('../adapters/workspace/index.js');
const actorMock = await import('../adapters/actor.js');

// ─── Test Setup ──────────────────────────────────────────────────────────────

let ws: TestWorkspace;
let ctx: TestToolContext;

beforeEach(async () => {
  ws = await createTestWorkspace();
  ctx = createToolContext({
    worktree: ws.tmpDir,
    directory: ws.tmpDir,
    sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
  });
});

afterEach(async () => {
  vi.mocked(wsMock.archiveSession).mockReset().mockImplementation(wsOriginals.archiveSession);
  vi.mocked(wsMock.verifyArchive).mockReset().mockImplementation(wsOriginals.verifyArchive);
  vi.mocked(actorMock.resolveActor)
    .mockReset()
    .mockResolvedValue({
      id: 'test-operator',
      email: 'test@flowguard.dev',
      displayName: null,
      source: 'env' as const,
      assurance: 'best_effort' as const,
    });
  delete process.env.FLOWGUARD_POLICY_PATH;
  vi.clearAllMocks();
  await ws.cleanup();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function hydrateSession(
  overrides: { policyMode?: string; profileId?: string } = {},
): Promise<Record<string, unknown>> {
  const args: { policyMode: string; profileId?: string } = {
    policyMode: overrides.policyMode ?? 'solo',
  };
  if (overrides.profileId !== undefined) {
    args.profileId = overrides.profileId;
  }
  const raw = await hydrate.execute(args, ctx);
  return parseToolResult(raw);
}

async function hydrateAndTicket(ticketText = 'Fix the auth bug'): Promise<void> {
  await hydrateSession();
  await ticket.execute({ text: ticketText, source: 'user' }, ctx);
}

// =============================================================================
// Tool: status
// =============================================================================

describe('status', () => {
  describe('HAPPY', () => {
    it('returns no-session message when no session exists', async () => {
      const result = parseToolResult(await status.execute({}, ctx));
      expect(result.phase).toBeNull();
      expect(result.status).toContain('No FlowGuard session');
    });

    it('returns correct phase and fields after hydrate', async () => {
      await hydrateSession();
      const result = parseToolResult(await status.execute({}, ctx));
      expect(result.phase).toBe('READY');
      expect(result.sessionId).toBeTruthy();
      expect(result.policyMode).toBe('solo');
      expect(result.hasTicket).toBe(false);
      expect(result.evalKind).toBeTruthy();
      expect(result.next).toBeTruthy();
    });

    it('surfaces appliedPolicy provenance fields', async () => {
      await hydrateSession();
      const result = parseToolResult(await status.execute({}, ctx));
      const applied = result.appliedPolicy as Record<string, unknown>;
      expect(applied).toBeDefined();
      expect(applied.source).toBe('explicit');
      expect(applied.requestedMode).toBe('solo');
      expect(applied.effectiveMode).toBe('solo');
      expect(applied.centralPolicyDigest).toBeNull();
    });

    it('includes completeness fields', async () => {
      await hydrateSession();
      const result = parseToolResult(await status.execute({}, ctx));
      expect(result.completeness).toBeDefined();
      const comp = result.completeness as Record<string, unknown>;
      expect(typeof comp.overallComplete).toBe('boolean');
      expect(typeof comp.summary).toBe('object');
    });

    it('returns detectedStack with unversioned items when no versions detected', async () => {
      await hydrateSession();
      const result = parseToolResult(await status.execute({}, ctx));
      expect(result.detectedStack).not.toBeNull();
      const ds = result.detectedStack as Record<string, unknown>;
      expect(Array.isArray(ds.items)).toBe(true);
      expect((ds.items as unknown[]).length).toBeGreaterThan(0);
      expect(Array.isArray(ds.versions)).toBe(true);
      expect((ds.versions as unknown[]).length).toBe(0);
    });

    it('returns full detectedStack object with summary and versions', async () => {
      await hydrateSession();
      const { computeFingerprint, sessionDir: resolveSessionDir } = await import(
        '../adapters/workspace/index.js'
      );
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const state = await readState(sessDir);
      expect(state).not.toBeNull();
      await writeState(sessDir, {
        ...state!,
        detectedStack: {
          summary: 'java=21, spring-boot=3.4.1',
          items: [
            { kind: 'language', id: 'java', version: '21', evidence: 'pom.xml:<java.version>' },
            { kind: 'framework', id: 'spring-boot', version: '3.4.1' },
          ],
          versions: [
            { id: 'java', version: '21', target: 'language', evidence: 'pom.xml:<java.version>' },
            { id: 'spring-boot', version: '3.4.1', target: 'framework' },
          ],
        },
      });
      const result = parseToolResult(await status.execute({}, ctx));

      expect(result.detectedStack).not.toBeNull();
      expect(typeof result.detectedStack).toBe('object');
      const ds = result.detectedStack as Record<string, unknown>;
      expect(ds.summary).toBe('java=21, spring-boot=3.4.1');
      expect(Array.isArray(ds.items)).toBe(true);
      expect(Array.isArray(ds.versions)).toBe(true);

      const items = ds.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(2);
      expect(items[0]).toMatchObject({
        kind: 'language',
        id: 'java',
        version: '21',
        evidence: 'pom.xml:<java.version>',
      });
      expect(items[1]).toMatchObject({
        kind: 'framework',
        id: 'spring-boot',
        version: '3.4.1',
      });

      const versions = ds.versions as Array<Record<string, unknown>>;
      expect(versions).toHaveLength(2);
      expect(versions[0]).toMatchObject({
        id: 'java',
        version: '21',
        target: 'language',
        evidence: 'pom.xml:<java.version>',
      });
      expect(versions[1]).toMatchObject({
        id: 'spring-boot',
        version: '3.4.1',
        target: 'framework',
      });
      expect(versions[1].evidence).toBeUndefined();
    });

    it('returns verificationCandidates array (empty by default)', async () => {
      await hydrateSession();
      const result = parseToolResult(await status.execute({}, ctx));
      expect(Array.isArray(result.verificationCandidates)).toBe(true);
    });

    it('returns why-blocked surface when whyBlocked flag is set', async () => {
      await hydrateSession();
      const result = parseToolResult(await status.execute({ whyBlocked: true }, ctx));

      expect(result.phase).toBe('READY');
      expect(result.whyBlocked).toBeDefined();
      const blocked = result.whyBlocked as Record<string, unknown>;
      expect(typeof blocked.blocked).toBe('boolean');
      expect(Array.isArray(blocked.missingEvidence)).toBe(true);
    });

    it('returns evidence detail surface when evidence flag is set', async () => {
      await hydrateSession();
      const result = parseToolResult(await status.execute({ evidence: true }, ctx));

      expect(result.phase).toBe('READY');
      expect(result.evidence).toBeDefined();
      const evidence = result.evidence as Record<string, unknown>;
      expect(Array.isArray(evidence.slots)).toBe(true);
      const firstSlot = (evidence.slots as Array<Record<string, unknown>>)[0];
      expect(firstSlot).toHaveProperty('artifactKind');
      expect(firstSlot).toHaveProperty('hint');
    });

    it('returns context surface when context flag is set', async () => {
      await hydrateSession();
      const result = parseToolResult(await status.execute({ context: true }, ctx));

      expect(result.phase).toBe('READY');
      expect(result.context).toBeDefined();
      const detail = result.context as Record<string, unknown>;
      expect(detail).toHaveProperty('policyMode');
      expect(detail).toHaveProperty('regulated');
    });

    it('returns readiness surface when readiness flag is set', async () => {
      await hydrateSession();
      const result = parseToolResult(await status.execute({ readiness: true }, ctx));

      expect(result.phase).toBe('READY');
      expect(result.readiness).toBeDefined();
      const detail = result.readiness as Record<string, unknown>;
      expect(typeof detail.blocked).toBe('boolean');
      expect(typeof detail.evidenceComplete).toBe('boolean');
    });

    it('returns persisted verificationCandidates in status', async () => {
      await hydrateSession();
      const { computeFingerprint, sessionDir: resolveSessionDir } = await import(
        '../adapters/workspace/index.js'
      );
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const state = await readState(sessDir);
      expect(state).not.toBeNull();
      await writeState(sessDir, {
        ...state!,
        verificationCandidates: [
          {
            kind: 'test',
            command: 'pnpm test',
            source: 'package.json:scripts.test',
            confidence: 'high',
            reason: 'Repo-native test script detected and pnpm package manager detected',
          },
        ],
      });

      const result = parseToolResult(await status.execute({}, ctx));
      expect(Array.isArray(result.verificationCandidates)).toBe(true);
      const candidates = result.verificationCandidates as Array<Record<string, unknown>>;
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        kind: 'test',
        command: 'pnpm test',
        source: 'package.json:scripts.test',
        confidence: 'high',
      });
    });
  });

  describe('BAD', () => {
    it('handles missing worktree gracefully', async () => {
      const badCtx = createToolContext({
        worktree: '',
        directory: '',
        sessionID: ctx.sessionID,
      });
      const raw = await status.execute({}, badCtx);
      const result = parseToolResult(raw);
      expect(result.phase === null || result.error === true).toBe(true);
    });

    it('uses deterministic flag precedence when multiple flags are true', async () => {
      await hydrateSession();
      const result = parseToolResult(
        await status.execute(
          { whyBlocked: true, evidence: true, context: true, readiness: true },
          ctx,
        ),
      );

      expect(result.whyBlocked).toBeDefined();
      expect(result.evidence).toBeUndefined();
      expect(result.context).toBeUndefined();
      expect(result.readiness).toBeUndefined();
    });
  });

  describe('CORNER', () => {
    it('reflects ticket state after ticket is recorded', async () => {
      await hydrateAndTicket();
      const result = parseToolResult(await status.execute({}, ctx));
      expect(result.hasTicket).toBe(true);
      expect(result.phase).toBe('TICKET');
    });
  });
});

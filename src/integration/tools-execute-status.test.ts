/**
 * @module integration/tools-execute-status.test
 * @description Execution tests for the status tool.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  createToolContext,
  createTestWorkspace,
  parseToolResult,
  withStrictReviewFindings,
  GIT_MOCK_DEFAULTS,
  type TestToolContext,
  type TestWorkspace,
  withTestEnv,
} from './test-helpers.js';
import {
  status,
  hydrate,
  ticket,
  plan,
  implement,
  decision,
  run_check,
  review,
  abort_session,
  archive,
  architecture,
  declare_contract,
} from './tools/index.js';
import {
  PersistenceError,
  readState,
  statePath,
  writeState,
  writeReport,
  reportPath,
} from '../adapters/persistence.js';
import { writeStateWithArtifacts } from './tools/helpers.js';
import { makeProgressedState } from '../fixtures.js';
import type { Phase } from '../state/schema.js';
import { evaluateCompleteness } from '../audit/completeness.js';
import { REVIEW_REPORT_SCHEMA_ID } from '../shared/flowguard-identifiers.js';

// ─── Zod v4 Metadata Regression (P1 review gate) ──────────────────────────────

describe('tool-schemas-zod-v4', () => {
  const allTools = {
    status,
    hydrate,
    ticket,
    plan,
    implement,
    decision,
    run_check,
    review,
    abort_session,
    archive,
    architecture,
  } as const;

  it('every tool exposes Zod v4 _zod metadata on all args', () => {
    for (const [name, tool] of Object.entries(allTools)) {
      for (const [argName, schema] of Object.entries(tool.args)) {
        const zodMeta = (schema as unknown as Record<string, unknown>)['_zod'];
        expect(zodMeta, `${name}.args.${argName} missing _zod`).toBeDefined();
        expect(typeof zodMeta, `${name}.args.${argName} _zod not object`).toBe('object');
        expect(
          (zodMeta as Record<string, unknown>)?.def,
          `${name}.args.${argName} missing _zod.def`,
        ).toBeDefined();
      }
    }
  });
});

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

const discoveryPersistenceOriginal = vi.hoisted(() => ({
  readDiscovery:
    null as unknown as (typeof import('../adapters/persistence-discovery.js'))['readDiscovery'],
}));

vi.mock('../adapters/persistence-discovery.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/persistence-discovery.js')>();
  discoveryPersistenceOriginal.readDiscovery = original.readDiscovery;
  return {
    ...original,
    readDiscovery: vi.fn(original.readDiscovery),
  };
});

const executorOriginal = vi.hoisted(() => ({
  executeCheck: null as unknown as (typeof import('../verification/executor.js'))['executeCheck'],
}));

vi.mock('../verification/executor.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../verification/executor.js')>();
  executorOriginal.executeCheck = original.executeCheck;
  return {
    ...original,
    executeCheck: vi.fn(original.executeCheck),
  };
});

const wsMock = await import('../adapters/workspace/index.js');
const actorMock = await import('../adapters/actor.js');
const discoveryPersistenceMock = await import('../adapters/persistence-discovery.js');
const executorMock = await import('../verification/executor.js');

// ─── Test Setup ──────────────────────────────────────────────────────────────

let ws: TestWorkspace;
let ctx: TestToolContext;
let cleanupEnv: () => void;

beforeEach(async () => {
  cleanupEnv = withTestEnv({ FLOWGUARD_POLICY_PATH: undefined });
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
  vi.mocked(discoveryPersistenceMock.readDiscovery)
    .mockReset()
    .mockImplementation(discoveryPersistenceOriginal.readDiscovery);
  vi.mocked(executorMock.executeCheck)
    .mockReset()
    .mockImplementation(executorOriginal.executeCheck);
  cleanupEnv();
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

    it('returns the advisory ProofGraph projection when proofGraph:true', async () => {
      await hydrateSession();
      const result = parseToolResult(await status.execute({ proofGraph: true }, ctx));
      expect(result.phase).toBe('READY');
      const pg = result.proofGraph as Record<string, unknown>;
      expect(pg).toBeDefined();
      expect(pg.criticalClaimCount).toBe(0);
      expect(pg.criticalUnprovenCount).toBe(0);
      const projection = pg.projection as Record<string, unknown>;
      expect(projection.version).toBe('proofgraph.v1');
      expect(projection.claims).toEqual([]);
      const registration = result.registrationConsistency as Record<string, unknown>;
      expect(registration).toBeDefined();
      expect(registration.ok).toBe(true);
      expect(registration.checkedCommands as number).toBeGreaterThan(0);
      const configConsistency = result.configConsistency as Record<string, unknown>;
      expect(configConsistency).toBeDefined();
      expect(configConsistency.ok).toBe(true);
      const gate = result.proofGraphGate as Record<string, unknown>;
      expect(gate).toBeDefined();
      expect(gate.enforced).toBe(false);
      expect(gate.gated).toBe(false);
    });

    it('inspects an aborted terminal session through read-only /status guidance', async () => {
      await hydrateSession();
      const aborted = parseToolResult(
        await abort_session.execute({ reason: 'Operator stopped the session' }, ctx),
      );
      expect(aborted.phase).toBe('COMPLETE');

      const result = parseToolResult(await status.execute({}, ctx));
      expect(result.phase).toBe('COMPLETE');
      const productNext = result.productNextAction as Record<string, unknown>;
      expect(productNext.commands).toEqual(['/status']);
      expect(productNext.text).toContain('/status');
      expect(productNext.text).not.toContain('/finish');
      expect(productNext.text).not.toContain('/export');

      // /status is read-only and therefore remains executable even though
      // terminal phases correctly reject every FlowGuard machine command.
      const statusProjection = result.status as Record<string, unknown>;
      expect(statusProjection.allowedCommands).toEqual([]);
    });

    it('includes mandates projection and recovery footer without runtime authorization', async () => {
      await hydrateSession();
      const result = parseToolResult(await status.execute({}, ctx));

      const mandates = result.governanceMandates as Record<string, unknown>;
      expect(mandates.source).toBe('src/templates/mandates.ts');
      expect(mandates.mandatesVerbosity).toBe('explicit');
      expect(mandates.renderFallbackIsPromptSafetyOnly).toBe(true);
      expect(mandates.runtimeAllowRequiresCanonicalStatePolicyPhaseEvidence).toBe(true);
      expect(String(mandates.phaseRelevantRules)).toContain('# FlowGuard Agent Rules');

      // Build identity is surfaced for stale-dist visibility (diagnostic only).
      const build = result.build as Record<string, unknown>;
      expect(build).toBeDefined();
      expect(build).toHaveProperty('version');
      expect(build).toHaveProperty('gitSha');
      expect(build).toHaveProperty('builtAt');
      expect(build).toHaveProperty('source');

      const footer = result.flowguardFooter as Record<string, unknown>;
      expect(footer.source).toBe('flowguard-tool-output-wrapper');
      expect(footer.authority).toBe('diagnostic-only');
      expect(footer.next).toBeUndefined();
      expect(footer.compactionRecoveryHint).toBeTruthy();
      expect(footer.renderFallbackIsPromptSafetyOnly).toBe(true);
      expect(footer.runtimeAllowRequiresCanonicalStatePolicyPhaseEvidence).toBe(true);
    });

    it('footer preserves canonical status output fields and blocked semantics', async () => {
      const noSession = parseToolResult(await status.execute({}, ctx));
      expect(noSession.phase).toBeNull();
      expect(noSession.status).toContain('No FlowGuard session');
      expect(noSession.next).toBe('Run /start to bootstrap a session.');
      expect(noSession.flowguardFooter).toMatchObject({
        authority: 'diagnostic-only',
        phase: 'unknown',
      });

      await hydrateSession();
      const hydrated = parseToolResult(await status.execute({}, ctx));
      expect(hydrated.phase).toBe('READY');
      expect(hydrated.next).toBeTruthy();
      expect(hydrated.nextAction).toBeTruthy();
      expect((hydrated.flowguardFooter as Record<string, unknown>).next).toBeUndefined();
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
      const { computeFingerprint, sessionDir: resolveSessionDir } =
        await import('../adapters/workspace/index.js');
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
      expect(versions[1]?.evidence).toBeUndefined();
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
      const { computeFingerprint, sessionDir: resolveSessionDir } =
        await import('../adapters/workspace/index.js');
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

    it('focused projections still carry verification-check fields (no VALIDATION dead-state)', async () => {
      // Regression: a focused status call (e.g. whyBlocked:true) must NOT strip the
      // verification-check fields that /check, /validate, and /implement gate on.
      // Otherwise a VALIDATION session looks like it has "no active checks" and can
      // never advance (flowguard_run_check is never invoked).
      await hydrateSession();
      const { computeFingerprint, sessionDir: resolveSessionDir } =
        await import('../adapters/workspace/index.js');
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const state = await readState(sessDir);
      expect(state).not.toBeNull();
      await writeState(sessDir, {
        ...state!,
        phase: 'VALIDATION',
        activeChecks: ['build'],
        validation: [],
        verificationCandidates: [
          {
            kind: 'build',
            command: './mvnw verify',
            source: 'repo:mvnw',
            confidence: 'high',
            reason: 'Maven wrapper detected',
          },
        ],
      });

      // Every focused flag must include the cheap state-derived check fields.
      for (const flag of ['whyBlocked', 'evidence', 'context', 'readiness'] as const) {
        const focused = parseToolResult(await status.execute({ [flag]: true }, ctx));
        expect(Array.isArray(focused.activeChecks)).toBe(true);
        expect(focused.activeChecks).toEqual(['build']);
        expect(Array.isArray(focused.verificationCandidates)).toBe(true);
        expect((focused.verificationCandidates as unknown[]).length).toBe(1);
        expect(focused.remainingChecks).toEqual(['build']);
      }

      // But the EXPENSIVE full-only discovery fields stay full-projection-only.
      const focusedEvidence = parseToolResult(await status.execute({ evidence: true }, ctx));
      expect(focusedEvidence.implementationGuidance).toBeUndefined();
      expect(focusedEvidence.discoveryDrift).toBeUndefined();
      expect(focusedEvidence.detectedStack).toBeUndefined();
    });
  });

  describe('finish flag (#520 — read-only Finish Card)', () => {
    it('returns no-session guidance instead of a card when no session exists', async () => {
      const result = parseToolResult(await status.execute({ finish: true }, ctx));
      expect(result.phase).toBeNull();
      expect(result.finish).toBeUndefined();
      expect(result.status).toContain('No FlowGuard session');
      expect(result.next).toBe('Run /start to bootstrap a session.');
    });

    it('returns a Finish Card projection for an existing session', async () => {
      await hydrateSession();
      const result = parseToolResult(await status.execute({ finish: true }, ctx));
      const finish = result.finish as Record<string, unknown>;
      expect(finish).toBeDefined();
      expect([
        'IN_PROGRESS',
        'READY',
        'READY_WITH_WARNINGS',
        'CHANGES_REQUIRED',
        'BLOCKED',
        'NOT_VERIFIED',
      ]).toContain(finish.overallStatus);
      expect(finish.readiness).toBeDefined();
      expect(finish.evidence).toBeDefined();
      expect(finish.blocker).toBeDefined();
      expect(finish.nextAction).toBeDefined();
      // Non-normative action framing + exit options.
      expect(Array.isArray(finish.actionGuidance)).toBe(true);
      expect(finish.exitOptions).toContain('abandon');
      // Constant read-only guarantees.
      expect(finish.guarantees).toEqual({
        readOnly: true,
        approves: false,
        consumesObligations: false,
        triggersExport: false,
      });
    });

    it('carries verification-check fields like other focused projections', async () => {
      await hydrateSession();
      const result = parseToolResult(await status.execute({ finish: true }, ctx));
      expect(Array.isArray(result.activeChecks)).toBe(true);
    });

    it('reports CHANGES_REQUIRED for a completed standalone review with issues', async () => {
      await hydrateSession();
      const { computeFingerprint, sessionDir: resolveSessionDir } =
        await import('../adapters/workspace/index.js');
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const current = await readState(sessDir);
      if (!current) throw new Error('expected hydrated state');
      const reviewState = {
        ...current,
        phase: 'REVIEW_COMPLETE' as const,
        reviewReportPath: reportPath(sessDir),
      };
      await writeState(sessDir, reviewState);
      await writeReport(sessDir, {
        schemaVersion: REVIEW_REPORT_SCHEMA_ID,
        sessionId: reviewState.id,
        generatedAt: '2026-01-01T00:00:00.000Z',
        phase: 'REVIEW_COMPLETE',
        planDigest: null,
        implDigest: null,
        validationSummary: [],
        findings: [{ severity: 'error', category: 'correctness', message: 'Changes required' }],
        overallStatus: 'issues',
        completeness: evaluateCompleteness(reviewState),
      });

      const result = parseToolResult(await status.execute({ finish: true }, ctx));
      const finish = result.finish as {
        overallStatus: string;
        actionGuidance: Array<{ action: string; status: string }>;
      };
      expect(finish.overallStatus).toBe('CHANGES_REQUIRED');
      expect(
        finish.actionGuidance.find((guidance) => guidance.action === 'create PR')?.status,
      ).toBe('not_recommended');
    });

    it('does not mutate persisted state (read-only)', async () => {
      await hydrateSession();
      const { computeFingerprint, sessionDir: resolveSessionDir } =
        await import('../adapters/workspace/index.js');
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const before = await readState(sessDir);
      await status.execute({ finish: true }, ctx);
      const after = await readState(sessDir);
      expect(after).toEqual(before);
    });

    it('returns a blocked error (no card) when session state is unreadable', async () => {
      await hydrateSession();
      const { computeFingerprint, sessionDir: resolveSessionDir } =
        await import('../adapters/workspace/index.js');
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      // Corrupt the persisted state so readState throws before any card is built.
      await fs.writeFile(statePath(sessDir), '{ this is not valid json', 'utf-8');

      const result = parseToolResult(await status.execute({ finish: true }, ctx));
      // No Finish Card is produced for an unreadable state; the failure is
      // surfaced as a blocked result carrying the persistence error code.
      expect(result.finish).toBeUndefined();
      expect(result.code).toBe('PARSE_FAILED');
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

  describe('discoveryHealth in status', () => {
    it('surfaces discoveryHealth after session creation', async () => {
      await hydrateSession();
      const result = parseToolResult(await status.execute({}, ctx));
      expect(result.discoveryHealth).toBeDefined();
      expect(result.discoveryHealth).not.toBeNull();
      const dh = result.discoveryHealth as Record<string, unknown>;
      expect(dh.kind).toBe('derived_discovery_health');
      expect(dh.advisory).toBe(true);
      expect(dh.source).toBe('persisted_discovery_result');
      expect(dh.status).toBe('available');
      expect(typeof dh.completeCollectors).toBe('number');
      expect(typeof dh.partialCollectors).toBe('number');
      expect(typeof dh.failedCollectors).toBe('number');
      expect(Array.isArray(dh.failedCollectorNames)).toBe(true);
      expect(typeof dh.hasBudgetExhaustion).toBe('boolean');
      expect(typeof dh.readFailureCount).toBe('number');
      expect(typeof dh.healthy).toBe('boolean');
      expect(dh.collectedAt).toBeDefined();
      expect(typeof dh.collectedAt).toBe('string');
    });

    it('returns discoveryHealth: null when no session (no discovery artifact)', async () => {
      const result = parseToolResult(await status.execute({}, ctx));
      expect(result.discoveryHealth).toBeNull();
    });

    it('profileRules includes discovery health guidance', async () => {
      await hydrateSession();
      const result = parseToolResult(await status.execute({}, ctx));
      expect(result.profileRules).toBeDefined();
      expect(typeof result.profileRules).toBe('string');
      expect(result.profileRules as string).toContain('## Discovery Health');
      expect(result.profileRules as string).toContain('Check flowguard_status.discoveryHealth');
      expect(result.profileRules as string).toContain('## Implementation Guidance');
      expect(result.profileRules as string).toContain('inspect implementationGuidance');
      expect(result.profileRules as string).toContain('## Discovery Drift');
      expect(result.profileRules as string).toContain('inspect discoveryDrift');
    });

    it('surfaces implementationGuidance only on full status responses', async () => {
      await hydrateAndTicket('Fix login auth bug in src/auth/login.ts');
      const full = parseToolResult(await status.execute({}, ctx));
      expect(full.implementationGuidance).toBeDefined();
      const guidance = full.implementationGuidance as Record<string, unknown>;
      expect(guidance.kind).toBe('derived_implementation_guidance');
      expect(guidance.advisory).toBe(true);
      expect(guidance.runtimeOnly).toBe(true);
      expect(guidance.notVerified).toEqual(
        expect.arrayContaining([expect.stringContaining('advisory')]),
      );

      const focused = parseToolResult(await status.execute({ evidence: true }, ctx));
      expect(focused.implementationGuidance).toBeUndefined();
      expect(focused.discoveryDrift).toBeUndefined();
    });

    it('surfaces discoveryDrift as clean on unchanged repository', async () => {
      await hydrateSession();
      const result = parseToolResult(await status.execute({}, ctx));
      const drift = result.discoveryDrift as Record<string, unknown>;

      expect(drift).toBeDefined();
      expect(drift.kind).toBe('derived_discovery_drift');
      expect(drift.advisory).toBe(true);
      expect(drift.runtimeOnly).toBe(true);
      expect(drift.status).toBe('clean');
      expect(drift.drifted).toBe(false);
      expect(typeof drift.currentDigest).toBe('string');
      expect(typeof drift.persistedDigest).toBe('string');
    });

    it('surfaces a read-only computed discoveryEvidenceGate distinct from the persisted gate', async () => {
      await hydrateSession();
      const result = parseToolResult(await status.execute({}, ctx));
      const evidenceGate = result.discoveryEvidenceGate as Record<string, unknown>;

      expect(evidenceGate).toBeDefined();
      expect(evidenceGate.source).toBe('computed_from_current_status_projection');
      // Default test policy does not enforce, so the live decision is pass.
      expect(evidenceGate.action).toBe('pass');
      expect(evidenceGate.code).toBeNull();
      // It is a separate field from the persisted sticky gate.
      expect('discoveryHealthGate' in result).toBe(true);
    });

    it('distinguishes stale discovery age from actual clean drift', async () => {
      await hydrateSession();
      const { computeFingerprint } = await import('../adapters/workspace/index.js');
      const fp = await computeFingerprint(ws.tmpDir);
      const { workspaceDir: resolveWorkspace } = await import('../adapters/workspace/index.js');
      const wsDir = resolveWorkspace(fp.fingerprint);
      const { readDiscovery, writeDiscovery } =
        await import('../adapters/persistence-discovery.js');
      const disc = await readDiscovery(wsDir);
      expect(disc).not.toBeNull();
      await writeDiscovery(wsDir, { ...disc!, collectedAt: '2000-01-01T00:00:00.000Z' });

      const statusResult = parseToolResult(await status.execute({}, ctx));
      const health = statusResult.discoveryHealth as Record<string, unknown>;
      const drift = statusResult.discoveryDrift as Record<string, unknown>;

      expect(health.ageWarning).toBeTruthy();
      expect(drift.status).toBe('clean');
      expect(drift.drifted).toBe(false);
    });

    it('surfaces missing discoveryDrift explicitly when discovery artifact is absent', async () => {
      await hydrateSession();
      const { computeFingerprint } = await import('../adapters/workspace/index.js');
      const fp = await computeFingerprint(ws.tmpDir);
      const { workspaceDir: resolveWorkspace } = await import('../adapters/workspace/index.js');
      const wsDir = resolveWorkspace(fp.fingerprint);
      await fs.rm(path.join(wsDir, 'discovery', 'discovery.json'));

      const result = parseToolResult(await status.execute({}, ctx));
      const drift = result.discoveryDrift as Record<string, unknown>;
      const health = result.discoveryHealth as Record<string, unknown>;
      expect(health.status).toBe('unavailable');
      expect(health.reason).toBe('missing');
      expect(health.healthy).toBe(false);
      expect(health.recovery).toContain('/hydrate');
      expect(health.notVerified).toEqual(
        expect.arrayContaining([expect.stringContaining('NOT_VERIFIED')]),
      );
      expect(drift.status).toBe('missing_discovery');
      expect(drift.drifted).toBeNull();
      expect(drift.notVerified).toEqual(
        expect.arrayContaining([expect.stringContaining('missing')]),
      );
    });

    it('returns explicit unavailable discoveryHealth when discovery artifact is corrupt', async () => {
      await hydrateSession();
      const { computeFingerprint } = await import('../adapters/workspace/index.js');
      const fp = await computeFingerprint(ws.tmpDir);
      const { workspaceDir: resolveWorkspace } = await import('../adapters/workspace/index.js');
      const wsDir = resolveWorkspace(fp.fingerprint);
      // Corrupt discovery.json by writing invalid JSON
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const discFile = path.join(wsDir, 'discovery', 'discovery.json');
      await fs.writeFile(discFile, 'not json');

      const result = parseToolResult(await status.execute({}, ctx));
      const health = result.discoveryHealth as Record<string, unknown>;
      expect(health.status).toBe('unavailable');
      expect(health.reason).toBe('corrupt');
      expect(health.healthy).toBe(false);
      expect(health.recovery).toContain('/hydrate');
      expect(health.notVerified).toEqual(
        expect.arrayContaining([expect.stringContaining('NOT_VERIFIED')]),
      );
      const drift = result.discoveryDrift as Record<string, unknown>;
      expect(drift.status).toBe('unavailable');
      expect(drift.notVerified).toEqual(
        expect.arrayContaining([expect.stringContaining('valid JSON')]),
      );
      expect(result.status).toBeDefined();
    });

    it('returns explicit unavailable discoveryHealth when discovery schema is invalid', async () => {
      await hydrateSession();
      const { computeFingerprint } = await import('../adapters/workspace/index.js');
      const fp = await computeFingerprint(ws.tmpDir);
      const { workspaceDir: resolveWorkspace } = await import('../adapters/workspace/index.js');
      const wsDir = resolveWorkspace(fp.fingerprint);
      const discFile = path.join(wsDir, 'discovery', 'discovery.json');
      await fs.writeFile(discFile, JSON.stringify({ schemaVersion: 'discovery.v1' }), 'utf-8');

      const result = parseToolResult(await status.execute({}, ctx));
      const health = result.discoveryHealth as Record<string, unknown>;
      expect(health.status).toBe('unavailable');
      expect(health.reason).toBe('schema_invalid');
      expect(health.healthy).toBe(false);
      expect(health.recovery).toContain('schema-valid discovery artifacts');
      expect(health.notVerified).toEqual(
        expect.arrayContaining([expect.stringContaining('NOT_VERIFIED')]),
      );
    });

    it('returns explicit unavailable discoveryHealth when discovery read fails', async () => {
      await hydrateSession();
      vi.mocked(discoveryPersistenceMock.readDiscovery).mockRejectedValueOnce(
        new PersistenceError('READ_FAILED', 'simulated read failure'),
      );

      const result = parseToolResult(await status.execute({}, ctx));
      const health = result.discoveryHealth as Record<string, unknown>;
      expect(health.status).toBe('unavailable');
      expect(health.reason).toBe('read_failed');
      expect(health.healthy).toBe(false);
      expect(health.recovery).toContain('filesystem access');
      expect(health.notVerified).toEqual(
        expect.arrayContaining([expect.stringContaining('NOT_VERIFIED')]),
      );
    });

    it('does not write discovery or session state during drift status projection', async () => {
      await hydrateSession();
      const { computeFingerprint, sessionDir: resolveSessionDir } =
        await import('../adapters/workspace/index.js');
      const fp = await computeFingerprint(ws.tmpDir);
      const { workspaceDir: resolveWorkspace } = await import('../adapters/workspace/index.js');
      const wsDir = resolveWorkspace(fp.fingerprint);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const discoveryPath = path.join(wsDir, 'discovery', 'discovery.json');
      const stateFile = statePath(sessDir);
      const beforeDiscovery = await fs.readFile(discoveryPath, 'utf-8');
      const beforeState = await fs.readFile(stateFile, 'utf-8');

      await status.execute({}, ctx);

      await expect(fs.readFile(discoveryPath, 'utf-8')).resolves.toBe(beforeDiscovery);
      await expect(fs.readFile(stateFile, 'utf-8')).resolves.toBe(beforeState);
    });

    it('profileRules includes dynamic degradation warning when collectors are degraded', async () => {
      await hydrateSession();
      const { computeFingerprint, sessionDir: resolveSessionDir } =
        await import('../adapters/workspace/index.js');
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const state = await readState(sessDir);
      expect(state).not.toBeNull();
      // Mutate discovery.json to simulate degraded discovery
      const { readDiscovery, writeDiscovery } =
        await import('../adapters/persistence-discovery.js');
      const { workspaceDir: resolveWorkspace } = await import('../adapters/workspace/index.js');
      const wsDir = resolveWorkspace(fp.fingerprint);
      const disc = await readDiscovery(wsDir);
      expect(disc).not.toBeNull();
      if (disc) {
        const degradedDisc = {
          ...disc,
          diagnostics: disc.diagnostics?.map((d: Record<string, unknown>) =>
            d.name === 'stack-detection'
              ? { ...d, status: 'failed', errorCode: 'TIMEOUT', timedOut: true }
              : d,
          ),
        };
        await writeDiscovery(wsDir, degradedDisc as typeof disc);
      }

      const result = parseToolResult(await status.execute({}, ctx));
      expect(result.discoveryHealth).toBeDefined();
      const dh = result.discoveryHealth as Record<string, unknown>;
      expect(dh.healthy).toBe(false);
      expect(dh.failedCollectors).toBeGreaterThan(0);
      expect(result.profileRules as string).toContain('WARNING: Discovery is degraded.');
    });

    it('surfaces persisted derivedRepairGuidance in status validationResults after a failing check', async () => {
      await hydrateSession();
      // Drive to VALIDATION: ticket → plan → self-review → approve
      const sd = await (async () => {
        const { computeFingerprint, sessionDir: resolveSessionDir } =
          await import('../adapters/workspace/index.js');
        const fp = await computeFingerprint(ws.tmpDir);
        return resolveSessionDir(fp.fingerprint, ctx.sessionID);
      })();
      await ticket.execute({ text: 'Fix the auth bug', source: 'user' }, ctx);
      await plan.execute(
        await withStrictReviewFindings(sd, {
          planText: '## Plan\nTest plan',
          targetPaths: ['docs/test.md'],
        }),
        ctx,
      );
      await plan.execute(await withStrictReviewFindings(sd, { reviewVerdict: 'accept' }), ctx);

      // Mock a failing check
      vi.mocked(executorMock.executeCheck).mockResolvedValueOnce({
        kind: 'typecheck',
        command: 'npx tsc --noEmit',
        exitCode: 1,
        passed: false,
        executionMs: 300,
        outputDigest: 'f'.repeat(64),
        stdout:
          "src/app.ts(10,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
        stderr: '',
        timedOut: false,
        startedAt: '2026-01-01T00:00:00.000Z',
      });

      await run_check.execute({ kind: 'typecheck' }, ctx);

      // Verify state persistence
      const state = await readState(sd);
      expect(state!.validation.length).toBe(1);
      const validation = state!.validation[0];
      expect(validation).toBeDefined();
      if (!validation) throw new TypeError('Expected persisted validation result');
      expect(validation.passed).toBe(false);
      const persistedGuidance = validation.derivedRepairGuidance;
      expect(persistedGuidance).toBeDefined();
      expect(persistedGuidance).toMatchObject({
        kind: 'derived_repair_guidance',
        advisory: true,
        source: 'run_check_output',
        status: 'available',
      });

      // Verify status surfaces the guidance
      const statusResult = parseToolResult(await status.execute({}, ctx));
      expect(Array.isArray(statusResult.validationResults)).toBe(true);
      const validationResults = statusResult.validationResults;
      if (!Array.isArray(validationResults)) throw new TypeError('Expected validation results');
      expect(validationResults.length).toBeGreaterThanOrEqual(1);
      const statusGuidance = (validationResults[0] as Record<string, unknown> | undefined)
        ?.derivedRepairGuidance as Record<string, unknown> | undefined;
      expect(statusGuidance).toBeDefined();
      if (!statusGuidance) throw new TypeError('Expected status repair guidance');
      expect(statusGuidance).toMatchObject({
        kind: 'derived_repair_guidance',
        advisory: true,
        source: 'run_check_output',
        status: 'available',
      });
      expect(statusGuidance.notVerified).toEqual(
        expect.arrayContaining([expect.stringContaining('NOT_VERIFIED')]),
      );
    });
  });
});

// =============================================================================
// Status ↔ Command-Prompt contract guard
//
// Every field a command PROMPT reads from flowguard_status must actually be
// emitted by the tool in the projection shape that command uses, in every phase
// the command is allowed to run. Three governed demos in a row wedged on a phase
// dead-state caused by a prompt↔tool contract gap (a prompt read a status field
// the tool did not emit in that call shape). This guard is the structural net.
//
// The "fields a prompt reads" are a CURATED map (declared here, reviewable),
// derived from the command templates in src/templates/commands/. It is kept
// curated rather than parsed from prompt prose, because Markdown parsing is
// fragile; a negative control proves the guard is sharp.
// =============================================================================

type CallShape = 'full' | 'whyBlocked' | 'evidence' | 'context' | 'readiness';

interface StatusContractEntry {
  /** Command whose prompt reads flowguard_status. */
  readonly label: string;
  /** Phases this command is allowed to run in (or '*' for all), used to scope the check. */
  readonly phases: readonly Phase[] | '*';
  /** The flowguard_status call shape the prompt uses. */
  readonly callShape: CallShape;
  /** Top-level status fields the prompt reads (must be emitted in every allowed phase). */
  readonly requiredTopLevel: readonly string[];
  /** Nested status paths the prompt reads, e.g. 'whyBlocked.reasonText'. */
  readonly requiredPaths?: readonly string[];
  /**
   * Top-level fields only required in specific phases (e.g. remainingChecks only
   * exists in VALIDATION). Checked only when the allowed phase matches.
   */
  readonly phaseGatedTopLevel?: ReadonlyArray<{ field: string; phases: readonly Phase[] }>;
}

// SOLL contract — the fields the (correct) prompts read from flowguard_status.
// reviewCard / pluginReviewFindings / gateNotice / policyResolution / _continue
// are intentionally absent: they come from other tool responses, not status.
const STATUS_CONTRACT: readonly StatusContractEntry[] = [
  {
    label: '/ticket',
    phases: ['READY', 'TICKET'],
    callShape: 'full',
    requiredTopLevel: ['phase', 'nextAction'],
  },
  {
    label: '/plan',
    phases: ['TICKET', 'PLAN'],
    callShape: 'full',
    // ticket BODY is NOT read from status (Gap C fix); only gating + candidates + profile rules.
    requiredTopLevel: [
      'phase',
      'hasTicket',
      'verificationCandidates',
      'profileRules',
      'detectedStack',
      'discoveryHealth',
      'discoveryDrift',
    ],
  },
  {
    label: '/implement',
    phases: ['IMPLEMENTATION'],
    callShape: 'full',
    // plan BODY is NOT read from status (Gap C fix); only gating + profile + discovery + validation.
    requiredTopLevel: [
      'phase',
      'hasPlan',
      'profileRules',
      'detectedStack',
      'verificationCandidates',
      'validationResults',
    ],
  },
  {
    label: '/validate',
    phases: ['VALIDATION'],
    callShape: 'full',
    // Gap A: activeChecks must be present in the FULL projection (was focused-only).
    requiredTopLevel: ['phase', 'activeChecks', 'verificationCandidates'],
    phaseGatedTopLevel: [{ field: 'remainingChecks', phases: ['VALIDATION'] }],
  },
  {
    label: '/review-decision',
    phases: ['PLAN_REVIEW', 'EVIDENCE_REVIEW', 'ARCH_REVIEW'],
    callShape: 'full',
    requiredTopLevel: ['phase'],
  },
  {
    label: '/review',
    phases: ['READY'],
    callShape: 'full',
    requiredTopLevel: [
      'phase',
      'discoveryHealth',
      'discoveryDrift',
      'detectedStack',
      'verificationCandidates',
    ],
  },
  {
    label: '/architecture',
    phases: ['READY', 'ARCHITECTURE'],
    callShape: 'full',
    requiredTopLevel: [
      'phase',
      'detectedStack',
      'verificationCandidates',
      'discoveryHealth',
      'discoveryDrift',
    ],
  },
  {
    label: '/archive',
    // /archive is a slash-command alias (flowguard_archive tool); its /status read
    // is only an existence/phase gate. Allowed broadly; check terminal phases.
    phases: ['COMPLETE', 'ARCH_COMPLETE', 'REVIEW_COMPLETE', 'IMPL_REVIEW'],
    callShape: 'full',
    requiredTopLevel: ['phase'],
  },
  {
    label: '/abort',
    phases: '*',
    callShape: 'full',
    requiredTopLevel: ['phase'],
  },
  {
    label: '/why',
    phases: '*',
    callShape: 'whyBlocked',
    requiredTopLevel: ['whyBlocked'],
    // Gap B: the blocker reason is under whyBlocked.*, NOT a top-level `blocker`.
    requiredPaths: [
      'whyBlocked.reasonText',
      'whyBlocked.reasonCode',
      'whyBlocked.nextResolvableCommand',
    ],
  },
];

// /check shares VALIDATE's contract (full projection, activeChecks/remainingChecks).
const CHECK_ENTRY: StatusContractEntry = {
  label: '/check',
  phases: ['VALIDATION'],
  callShape: 'full',
  requiredTopLevel: ['activeChecks', 'verificationCandidates'],
  phaseGatedTopLevel: [{ field: 'remainingChecks', phases: ['VALIDATION'] }],
};

const ALL_PHASES: readonly Phase[] = [
  'READY',
  'TICKET',
  'PLAN',
  'PLAN_REVIEW',
  'VALIDATION',
  'IMPLEMENTATION',
  'IMPL_REVIEW',
  'EVIDENCE_REVIEW',
  'COMPLETE',
  'ARCHITECTURE',
  'ARCH_REVIEW',
  'ARCH_COMPLETE',
  'REVIEW',
  'REVIEW_COMPLETE',
];

describe('status-prompt-contract', () => {
  let ws2: TestWorkspace;
  let ctx2: TestToolContext;
  let cleanupEnv2: () => void;

  beforeEach(async () => {
    cleanupEnv2 = withTestEnv({ FLOWGUARD_POLICY_PATH: undefined });
    ws2 = await createTestWorkspace();
    ctx2 = createToolContext({
      worktree: ws2.tmpDir,
      directory: ws2.tmpDir,
      sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
    });
  });

  afterEach(async () => {
    cleanupEnv2();
    await ws2.cleanup();
  });

  async function statusFor(phase: Phase, callShape: CallShape): Promise<Record<string, unknown>> {
    const { computeFingerprint, sessionDir: resolveSessionDir } =
      await import('../adapters/workspace/index.js');
    const fp = await computeFingerprint(ws2.tmpDir);
    const sessDir = resolveSessionDir(fp.fingerprint, ctx2.sessionID);
    // Seed canonical state at the requested phase, preserving the session id/binding
    // that the tool resolves from ctx2.
    const seeded = { ...makeProgressedState(phase), id: makeProgressedState(phase).id };
    await writeState(sessDir, seeded);
    const args = callShape === 'full' ? {} : ({ [callShape]: true } as Record<string, boolean>);
    return parseToolResult(await status.execute(args, ctx2));
  }

  function hasPath(obj: Record<string, unknown>, dottedPath: string): boolean {
    const parts = dottedPath.split('.');
    let cur: unknown = obj;
    for (const p of parts) {
      if (cur === null || typeof cur !== 'object' || !(p in (cur as object))) return false;
      cur = (cur as Record<string, unknown>)[p];
    }
    return cur !== undefined;
  }

  const entries = [...STATUS_CONTRACT, CHECK_ENTRY];

  for (const entry of entries) {
    const phases = entry.phases === '*' ? ALL_PHASES : entry.phases;
    it(`${entry.label}: status (${entry.callShape}) emits required fields in all allowed phases`, async () => {
      expect(phases.length).toBeGreaterThan(0);
      for (const phase of phases) {
        const result = await statusFor(phase, entry.callShape);
        for (const field of entry.requiredTopLevel) {
          expect(
            field in result,
            `${entry.label} reads top-level "${field}" but status(${entry.callShape}) in ${phase} did not emit it`,
          ).toBe(true);
        }
        for (const p of entry.requiredPaths ?? []) {
          expect(
            hasPath(result, p),
            `${entry.label} reads "${p}" but status(${entry.callShape}) in ${phase} did not emit it`,
          ).toBe(true);
        }
        for (const gated of entry.phaseGatedTopLevel ?? []) {
          if (gated.phases.includes(phase)) {
            expect(
              gated.field in result,
              `${entry.label} reads "${gated.field}" in ${phase} but status(${entry.callShape}) did not emit it`,
            ).toBe(true);
          }
        }
      }
    });
  }

  // Negative control: a field NO prompt reads must NOT be present — proves the
  // guard would actually fail if a required field were missing/renamed.
  it('NEGATIVE CONTROL: a made-up field is absent from full status (guard is sharp)', async () => {
    const result = await statusFor('VALIDATION', 'full');
    expect('madeUpFieldThatNoPromptReads' in result).toBe(false);
  });

  // Gap B documentation: the focused whyBlocked projection has NO top-level
  // `blocker` key (the old /why prompt incorrectly read blocker.*). The reason
  // lives under whyBlocked.* — asserted by the /why contract entry above.
  it('Gap B: focused whyBlocked has no top-level "blocker" (reason is under whyBlocked.*)', async () => {
    const result = await statusFor('VALIDATION', 'whyBlocked');
    expect('blocker' in result).toBe(false);
    expect(hasPath(result, 'whyBlocked.reasonText')).toBe(true);
  });
});

// =============================================================================
// Tool: declare_contract (ProofGraph declaration, #762)
// =============================================================================

describe('declare_contract', () => {
  const NOW = '2026-01-01T00:00:00.000Z';
  const SHA = 'a'.repeat(64);

  async function seedImplValidation(
    overrides: { checkId?: string; passed?: boolean; digest?: string } = {},
  ): Promise<string> {
    const checkId = overrides.checkId ?? 'test';
    const digest = overrides.digest ?? 'impl-digest-1';
    await hydrateSession();
    const { computeFingerprint, sessionDir: resolveSessionDir } =
      await import('../adapters/workspace/index.js');
    const fp = await computeFingerprint(ws.tmpDir);
    const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
    const state = await readState(sessDir);
    await writeStateWithArtifacts(sessDir, {
      ...state!,
      phase: 'IMPL_VALIDATION',
      activeChecks: [checkId, 'security'],
      ticket: { text: 'approved ticket', digest: 'ticket-digest', source: 'user', createdAt: NOW },
      implementation: { changedFiles: ['a.ts'], domainFiles: [], digest, executedAt: NOW },
      validationAttempts: [
        {
          attemptId: crypto.randomUUID(),
          scope: 'implementation',
          implementationDigest: digest,
          result: {
            checkId,
            passed: overrides.passed ?? true,
            detail: '',
            executedAt: NOW,
            kind: 'test',
            command: 'npm test',
            exitCode: (overrides.passed ?? true) ? 0 : 1,
            executionMs: 5,
            outputDigest: SHA,
            timedOut: false,
          },
        },
        {
          attemptId: crypto.randomUUID(),
          scope: 'implementation',
          implementationDigest: digest,
          result: {
            checkId: 'security',
            passed: true,
            detail: '',
            executedAt: NOW,
            kind: 'security',
            command: 'npm run security',
            exitCode: 0,
            executionMs: 5,
            outputDigest: SHA,
            timedOut: false,
          },
        },
      ],
    });
    return sessDir;
  }

  it('declares a claim, persists the contract + projection, and reports PROVEN', async () => {
    const sessDir = await seedImplValidation({ checkId: 'test', passed: true });
    const result = parseToolResult(
      await declare_contract.execute(
        {
          claims: [
            {
              statement: 'the change is covered by the test check',
              checkId: 'test',
              counterexampleCheckId: 'security',
              authority: 'ticket',
            },
          ],
        },
        ctx,
      ),
    );
    const projection = result.proofGraph as Record<string, unknown>;
    expect(projection).toBeDefined();
    const claims = projection.claims as Array<Record<string, unknown>>;
    expect(claims).toHaveLength(1);
    expect(claims[0]!.signalClass).toBe('fact');
    expect(claims[0]!.verificationState).toBe('PROVEN');

    const persisted = await readState(sessDir);
    expect(persisted!.proofContract?.claims).toHaveLength(1);
    expect(persisted!.proofGraph?.claims[0]?.verificationState).toBe('PROVEN');
  });

  // AC#11 (#762): one critical claim carrying an executed positive test, a
  // negative/fault scenario, and a structural consistency assertion together.
  describe('combined evidence on a single critical claim', () => {
    const COMBINED = {
      statement: 'the declared command surface is consistent and covered by tests',
      checkId: 'test',
      counterexampleCheckId: 'security',
      authority: 'ticket' as const,
      structuralSurface: 'command-registration' as const,
    };

    it('is PROVEN with positive + negative + structural evidence bound to one claim', async () => {
      const sessDir = await seedImplValidation({ checkId: 'test', passed: true });
      const result = parseToolResult(await declare_contract.execute({ claims: [COMBINED] }, ctx));
      const claim = (result.proofGraph as Record<string, unknown>).claims as Array<
        Record<string, unknown>
      >;
      expect(claim).toHaveLength(1);
      expect(claim[0]!.critical).toBe(true);
      expect(claim[0]!.signalClass).toBe('fact');
      expect(claim[0]!.verificationState).toBe('PROVEN');

      // All three evidence kinds are actually bound to this one claim.
      const persisted = await readState(sessDir);
      const declared = persisted!.proofContract!.claims[0]!;
      expect(declared.evidenceRefs.map((r) => r.kind).sort()).toEqual([
        'structural_surface',
        'validation_attempt',
      ]);
      expect(declared.counterexampleRefs.map((r) => r.kind)).toEqual(['validation_attempt']);
      // The structural assertion is REQUIRED evidence, not decoration.
      expect([...declared.requiredEvidence!.positive].sort()).toEqual([
        'executed_test',
        'structural_assertion',
      ]);
      expect(declared.requiredEvidence!.adversarial).toEqual(['counterexample']);
    });

    it('is CONTRADICTED when the negative/fault scenario actually falsifies it', async () => {
      await hydrateSession();
      const { computeFingerprint, sessionDir: resolveSessionDir } =
        await import('../adapters/workspace/index.js');
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const state = await readState(sessDir);
      const digest = 'impl-combined';
      const attempt = (checkId: string, passed: boolean) => ({
        attemptId: crypto.randomUUID(),
        scope: 'implementation' as const,
        implementationDigest: digest,
        result: {
          checkId,
          passed,
          detail: '',
          executedAt: NOW,
          kind: checkId === 'security' ? ('security' as const) : ('test' as const),
          command: 'run',
          exitCode: passed ? 0 : 1,
          executionMs: 5,
          outputDigest: SHA,
          timedOut: false,
        },
      });
      await writeStateWithArtifacts(sessDir, {
        ...state!,
        phase: 'IMPL_VALIDATION',
        activeChecks: ['test', 'security'],
        ticket: {
          text: 'approved ticket',
          digest: 'ticket-digest',
          source: 'user',
          createdAt: NOW,
        },
        implementation: { changedFiles: ['a.ts'], domainFiles: [], digest, executedAt: NOW },
        validationAttempts: [attempt('test', true), attempt('security', false)],
      });
      const result = parseToolResult(await declare_contract.execute({ claims: [COMBINED] }, ctx));
      const claims = (result.proofGraph as Record<string, unknown>).claims as Array<
        Record<string, unknown>
      >;
      // Falsification wins over the passing positive and structural evidence.
      expect(claims[0]!.verificationState).toBe('CONTRADICTED');
    });
  });

  it('reports NOT_VERIFIED for a critical claim with no adversarial counterexample', async () => {
    await seedImplValidation({ checkId: 'test', passed: true });
    const result = parseToolResult(
      await declare_contract.execute(
        {
          claims: [{ statement: 'critical but unfalsified', checkId: 'test', authority: 'ticket' }],
        },
        ctx,
      ),
    );
    const claims = (result.proofGraph as Record<string, unknown>).claims as Array<
      Record<string, unknown>
    >;
    expect(claims[0]!.signalClass).toBe('fact');
    expect(claims[0]!.verificationState).toBe('NOT_VERIFIED');
  });

  it('classifies a claim without an approved authority as a NOT_VERIFIED hypothesis', async () => {
    await seedImplValidation({ checkId: 'test', passed: true });
    const result = parseToolResult(
      await declare_contract.execute(
        { claims: [{ statement: 'unsourced assertion', checkId: 'test' }] },
        ctx,
      ),
    );
    const claims = (result.proofGraph as Record<string, unknown>).claims as Array<
      Record<string, unknown>
    >;
    expect(claims[0]!.signalClass).toBe('hypothesis');
    expect(claims[0]!.provenance).toBeNull();
    expect(claims[0]!.verificationState).toBe('NOT_VERIFIED');
  });

  it('reports UNPROVEN when the covering check failed', async () => {
    await seedImplValidation({ checkId: 'test', passed: false });
    const result = parseToolResult(
      await declare_contract.execute(
        {
          claims: [
            { statement: 'covered by a failing check', checkId: 'test', authority: 'ticket' },
          ],
        },
        ctx,
      ),
    );
    const claims = (result.proofGraph as Record<string, unknown>).claims as Array<
      Record<string, unknown>
    >;
    expect(claims[0]!.verificationState).toBe('UNPROVEN');
  });

  it('fails closed when the referenced check has no implementation attempt', async () => {
    await seedImplValidation({ checkId: 'test' });
    const result = parseToolResult(
      await declare_contract.execute({ claims: [{ statement: 'x', checkId: 'lint' }] }, ctx),
    );
    expect(result.error).toBe(true);
    expect(result.code).toBe('PROOFGRAPH_CLAIM_EVIDENCE_UNRESOLVED');
  });

  it('is not allowed outside the implementation phases', async () => {
    await hydrateSession();
    const result = parseToolResult(
      await declare_contract.execute({ claims: [{ statement: 'x', checkId: 'test' }] }, ctx),
    );
    expect(result.error).toBe(true);
    expect(result.code).toBe('COMMAND_NOT_ALLOWED');
  });

  it('reports CONTRADICTED when a declared counterexample check failed', async () => {
    await hydrateSession();
    const { computeFingerprint, sessionDir: resolveSessionDir } =
      await import('../adapters/workspace/index.js');
    const fp = await computeFingerprint(ws.tmpDir);
    const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
    const state = await readState(sessDir);
    const digest = 'impl-cx';
    function attempt(checkId: string, passed: boolean) {
      return {
        attemptId: crypto.randomUUID(),
        scope: 'implementation' as const,
        implementationDigest: digest,
        result: {
          checkId,
          passed,
          detail: '',
          executedAt: NOW,
          kind: checkId === 'security' ? ('security' as const) : ('test' as const),
          command: 'run',
          exitCode: passed ? 0 : 1,
          executionMs: 5,
          outputDigest: SHA,
          timedOut: false,
        },
      };
    }
    await writeStateWithArtifacts(sessDir, {
      ...state!,
      phase: 'IMPL_REVIEW',
      activeChecks: ['test', 'security'],
      ticket: { text: 'approved ticket', digest: 'ticket-digest', source: 'user', createdAt: NOW },
      implementation: { changedFiles: ['a.ts'], domainFiles: [], digest, executedAt: NOW },
      validationAttempts: [attempt('test', true), attempt('security', false)],
    });
    const result = parseToolResult(
      await declare_contract.execute(
        {
          claims: [
            {
              statement: 'the change is safe',
              checkId: 'test',
              counterexampleCheckId: 'security',
              authority: 'ticket',
            },
          ],
        },
        ctx,
      ),
    );
    const claims = (result.proofGraph as Record<string, unknown>).claims as Array<
      Record<string, unknown>
    >;
    expect(claims[0]!.verificationState).toBe('CONTRADICTED');
    const persisted = await readState(sessDir);
    expect(persisted!.proofGraph?.claims[0]?.verificationState).toBe('CONTRADICTED');
  });
});

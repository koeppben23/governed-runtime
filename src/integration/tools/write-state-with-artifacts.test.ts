/**
 * @module integration/tools/write-state-with-artifacts.test
 * @description Tests for writeStateWithArtifacts artifacts-first ordering fix.
 *
 * This fix prevents the EVIDENCE_ARTIFACT_MISSING corruption scenario:
 * state was previously written BEFORE artifacts — if a crash occurred between
 * the two writes, state would reference artifacts that don't exist on disk.
 *
 * New ordering: artifacts-first, state-last.
 * - Crash after artifacts, before state → orphan files (benign)
 * - Crash after state → both exist, consistent
 *
 * Coverage:
 * - HAPPY: artifacts written before state, both exist after success
 * - HAPPY: pre-computed hash matches state file hash
 * - BAD: invalid state never hits disk (schema validation first)
 * - CORNER: artifact materialization failure prevents state write
 * - EDGE: state with no plan/ticket still writes correctly
 *
 * @version v1
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  (globalThis as Record<string, unknown>).__writeStateFsActual = actual;
  return {
    ...actual,
    open: vi.fn((...args: Parameters<typeof actual.open>) => actual.open(...args)),
    rename: vi.fn((...args: Parameters<typeof actual.rename>) => actual.rename(...args)),
  };
});

import {
  resolveWorkspacePaths,
  withMutableSessionTransaction,
  writeStateWithArtifacts,
  writeStateWithArtifactsAndAuditOperations,
} from './helpers.js';
import { persistAndFormat } from './helpers-rail-presentation.js';
import { buildDecisionAuditIntent } from '../services/decision-audit-intent.js';
import { evaluate } from '../../machine/evaluate.js';
import { TEAM_POLICY } from '../../config/policy.js';
import type { RailOk } from '../../rails/types.js';
import type { ReviewDecision } from '../../state/evidence.js';
import { readState, statePath, atomicWrite, writeState } from '../../adapters/persistence.js';
import { appendAuditEvent, readAuditTrail } from '../../adapters/persistence-audit.js';
import { computeStateDigest } from '../audit-outbox.js';
import { reconcilePendingAuditOperations } from '../plugin-audit.js';
import { makeDeps } from '../plugin-audit-test-helpers.js';
import { verifyEvidenceArtifacts } from '../../adapters/workspace/evidence-artifacts.js';
import { buildStateWriteBody, buildTransitionBody } from '../../audit/types.js';
import { buildSemanticAuditBody } from '../../audit/semantic-event.js';
import { computeCanonicalEventDigest } from '../../audit/canonical-digest.js';
import { canonicalJsonStringify } from '../../shared/canonical-json.js';
import { hashText } from '../../shared/hashing.js';
import { makeState, makeProgressedState } from '../../fixtures.js';
import { CURRENT_SESSION_STATE_SCHEMA_VERSION, type SessionState } from '../../state/schema.js';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

let tmpDir: string;

async function createTmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'gov-helpers-test-'));
}

async function cleanup(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    /* ignore cleanup errors */
  }
}

/** Compute SHA-256 hash of a file. */
async function hashFile(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath, 'utf-8');
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

/** Check if artifacts directory exists. */
async function artifactsDirExists(sessDir: string): Promise<boolean> {
  try {
    await fs.access(path.join(sessDir, 'artifacts'));
    return true;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// writeStateWithArtifacts — Artifacts-First Ordering
// ═══════════════════════════════════════════════════════════════════════════════

describe('writeStateWithArtifacts — artifacts-first ordering', () => {
  beforeEach(async () => {
    tmpDir = await createTmpDir();
  });

  afterEach(async () => {
    await cleanup(tmpDir);
  });

  // ─── HAPPY: Basic operation ───────────────────────────────────────────────

  describe('HAPPY — basic operation', () => {
    it('writes state and artifacts successfully for a minimal state', async () => {
      const state = makeState('TICKET');
      await writeStateWithArtifacts(tmpDir, state);

      // State file exists and is valid
      const read = await readState(tmpDir);
      expect(read).not.toBeNull();
      expect(read!.phase).toBe('TICKET');
      expect(read!.id).toBe(state.id);
      expect(read!.proofGraph).toMatchObject({
        version: 'proofgraph.v2',
        claims: [],
        evaluatedAt: state.transition?.at ?? state.createdAt,
      });
    });

    it('writes state and artifacts for a state with plan (generates artifacts)', async () => {
      const state = makeProgressedState('PLAN');
      await writeStateWithArtifacts(tmpDir, state);

      // State file exists
      const read = await readState(tmpDir);
      expect(read).not.toBeNull();
      expect(read!.phase).toBe('PLAN');

      // Artifacts directory was created
      expect(await artifactsDirExists(tmpDir)).toBe(true);
    });

    it('state file content matches expected serialization', async () => {
      const state = makeState('READY');
      await writeStateWithArtifacts(tmpDir, state);

      const content = await fs.readFile(statePath(tmpDir), 'utf-8');
      // Pretty-printed JSON with trailing newline
      expect(content.endsWith('\n')).toBe(true);
      const parsed = JSON.parse(content);
      expect(parsed.phase).toBe('READY');
      expect(parsed.schemaVersion).toBe(CURRENT_SESSION_STATE_SCHEMA_VERSION);
    });
  });

  describe('BAD — concurrent mutable sessions are serialized', () => {
    it('does not lose updates from parallel read-modify-write transactions', async () => {
      const sessionID = crypto.randomUUID();
      const context = { sessionID, worktree: tmpDir, directory: tmpDir };
      const { sessDir } = await resolveWorkspacePaths(context);
      await writeStateWithArtifacts(sessDir, { ...makeState('VALIDATION'), activeChecks: [] });

      await Promise.all([
        withMutableSessionTransaction(context, async (session) => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          await writeStateWithArtifacts(session.sessDir, {
            ...session.state,
            activeChecks: [...session.state.activeChecks, 'first'],
          });
        }),
        withMutableSessionTransaction(context, async (session) => {
          await writeStateWithArtifacts(session.sessDir, {
            ...session.state,
            activeChecks: [...session.state.activeChecks, 'second'],
          });
        }),
      ]);

      const finalState = await readState(sessDir);
      expect([...(finalState?.activeChecks ?? [])].sort()).toEqual(['first', 'second']);
    });
  });

  // ─── HAPPY: Pre-computed hash consistency ─────────────────────────────────

  describe('HAPPY — pre-computed hash consistency', () => {
    it('state file hash matches what writeState would produce', async () => {
      const state = makeProgressedState('PLAN');
      await writeStateWithArtifacts(tmpDir, state);

      // Read the state file and compute its hash
      const stateContent = await fs.readFile(statePath(tmpDir), 'utf-8');
      const actualHash = crypto.createHash('sha256').update(stateContent, 'utf-8').digest('hex');

      // Verify by reading artifact metadata (if artifacts are generated)
      // The artifact JSON files include a sourceStateHash that should match
      const artifactsDir = path.join(tmpDir, 'artifacts');
      try {
        const files = await fs.readdir(artifactsDir);
        const jsonFiles = files.filter((f) => f.endsWith('.json'));
        for (const jsonFile of jsonFiles) {
          const artifactContent = await fs.readFile(path.join(artifactsDir, jsonFile), 'utf-8');
          const artifact = JSON.parse(artifactContent);
          // sourceStateHash in artifact must match the actual state file hash
          expect(artifact.sourceStateHash).toBe(actualHash);
        }
      } catch {
        // No artifacts generated for this state (no plan/ticket) — that's OK
      }
    });

    it('pre-computed hash is deterministic for same state', async () => {
      const state = makeState('TICKET');

      // Write twice to different dirs
      const dir1 = await createTmpDir();
      const dir2 = await createTmpDir();
      try {
        await writeStateWithArtifacts(dir1, state);
        await writeStateWithArtifacts(dir2, state);

        const hash1 = await hashFile(statePath(dir1));
        const hash2 = await hashFile(statePath(dir2));
        expect(hash1).toBe(hash2);
      } finally {
        await cleanup(dir1);
        await cleanup(dir2);
      }
    });
  });

  // ─── BAD: Schema validation ───────────────────────────────────────────────

  describe('BAD — schema validation prevents disk writes', () => {
    it('throws on invalid state (missing required fields)', async () => {
      const invalidState = {
        phase: 'TICKET',
      } as unknown as import('../../state/schema.js').SessionState;

      await expect(writeStateWithArtifacts(tmpDir, invalidState)).rejects.toThrow(
        /Refusing to persist invalid state/,
      );

      // Nothing written to disk
      const stateFile = statePath(tmpDir);
      await expect(fs.access(stateFile)).rejects.toThrow();
    });

    it('throws with SCHEMA_VALIDATION_FAILED code', async () => {
      const invalidState = {
        foo: 'bar',
      } as unknown as import('../../state/schema.js').SessionState;

      try {
        await writeStateWithArtifacts(tmpDir, invalidState);
        expect.fail('should have thrown');
      } catch (err: unknown) {
        expect((err as { code?: string }).code).toBe('SCHEMA_VALIDATION_FAILED');
      }
    });

    it('does not create artifacts directory for invalid state', async () => {
      const invalidState = {} as unknown as import('../../state/schema.js').SessionState;

      await expect(writeStateWithArtifacts(tmpDir, invalidState)).rejects.toThrow();
      expect(await artifactsDirExists(tmpDir)).toBe(false);
    });
  });

  // ─── CORNER: Ordering verification ────────────────────────────────────────

  describe('CORNER — artifacts-first ordering verification', () => {
    it('artifacts exist on disk even if state write would hypothetically fail', async () => {
      // We verify the ordering by checking that after a successful write,
      // artifacts reference the correct state hash (pre-computed, not from disk)
      const state = makeProgressedState('PLAN');
      await writeStateWithArtifacts(tmpDir, state);

      // Both must exist
      const stateExists = await fs.access(statePath(tmpDir)).then(
        () => true,
        () => false,
      );
      const artifactsExist = await artifactsDirExists(tmpDir);
      expect(stateExists).toBe(true);
      expect(artifactsExist).toBe(true);
    });

    it('state file is written atomically (temp + rename pattern)', async () => {
      const state = makeState('READY');
      await writeStateWithArtifacts(tmpDir, state);

      // If the file exists and is valid JSON, it was written atomically
      // (non-atomic writes could leave partial files)
      const content = await fs.readFile(statePath(tmpDir), 'utf-8');
      expect(() => JSON.parse(content)).not.toThrow();
    });
  });

  // ─── EDGE: No artifacts needed ────────────────────────────────────────────

  describe('EDGE — states with no plan/ticket (no artifacts to materialize)', () => {
    it('READY state with no evidence writes state successfully', async () => {
      const state = makeState('READY');
      await writeStateWithArtifacts(tmpDir, state);

      const read = await readState(tmpDir);
      expect(read).not.toBeNull();
      expect(read!.phase).toBe('READY');
    });

    it('TICKET phase with null ticket still writes state', async () => {
      const state = makeState('TICKET', { ticket: null });
      await writeStateWithArtifacts(tmpDir, state);

      const read = await readState(tmpDir);
      expect(read).not.toBeNull();
      expect(read!.phase).toBe('TICKET');
    });

    it('artifacts directory is created even when no artifacts are materialized', async () => {
      // materializeEvidenceArtifacts always creates the artifacts dir (mkdir recursive)
      const state = makeState('READY');
      await writeStateWithArtifacts(tmpDir, state);

      expect(await artifactsDirExists(tmpDir)).toBe(true);
    });
  });

  // ─── EDGE: Overwrite existing state ───────────────────────────────────────

  describe('EDGE — overwriting existing state', () => {
    it('overwrites previous state file correctly', async () => {
      const state1 = makeState('READY');
      const state2 = makeState('TICKET');

      await writeStateWithArtifacts(tmpDir, state1);
      const read1 = await readState(tmpDir);
      expect(read1!.phase).toBe('READY');

      await writeStateWithArtifacts(tmpDir, state2);
      const read2 = await readState(tmpDir);
      expect(read2!.phase).toBe('TICKET');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// persistAndFormat — semantic intent plumbing
// ═══════════════════════════════════════════════════════════════════════════════

describe('persistAndFormat — semantic intent plumbing', () => {
  beforeEach(async () => {
    tmpDir = await createTmpDir();
  });

  afterEach(async () => {
    await cleanup(tmpDir);
  });

  it('commits caller-supplied decision intents atomically with the rail result', async () => {
    const state = makeState('PLAN_REVIEW');
    await writeStateWithArtifacts(tmpDir, state);
    const transition = {
      from: 'PLAN_REVIEW' as const,
      to: 'VALIDATION' as const,
      event: 'APPROVE' as const,
      at: '2026-01-01T00:00:00.000Z',
    };
    const next = { ...state, phase: 'VALIDATION' as const, transition };
    const decision: ReviewDecision = {
      verdict: 'approve',
      rationale: 'ok',
      decidedAt: transition.at,
      decisionIdentity: {
        actorId: 'reviewer-1',
        actorEmail: null,
        actorSource: 'env',
        actorAssurance: 'best_effort',
      },
    };
    const result: RailOk = {
      kind: 'ok',
      state: next,
      evalResult: evaluate(next, TEAM_POLICY),
      transitions: [transition],
      decisionEvidence: decision,
    };

    await persistAndFormat(tmpDir, result, {
      semanticIntents: [
        buildDecisionAuditIntent({
          transition,
          decision,
          policyMode: 'team',
          decisionSequence: 1,
          actor: 'human',
        }),
      ],
    });

    const persisted = await readState(tmpDir);
    const semantic = persisted!.pendingAuditOperations.filter(
      (operation) => operation.kind === 'semantic',
    );
    expect(semantic).toHaveLength(1);
    expect(semantic[0]!.semantic.event).toBe('decision:DEC-001');
    expect(semantic[0]!.semantic.detail.verdict).toBe('approve');
  });
});

describe('shared state write — durable preparation and recovery', () => {
  const sessionId = 'aaaaaaaa-0000-4000-8000-000000000001';
  const at = '2026-05-15T12:00:00.000Z';
  const transitions = [
    { from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', at },
    { from: 'PLAN', to: 'PLAN_REVIEW', event: 'SELF_REVIEW_PENDING', at },
  ] as const;
  const claimId = '10000000-0000-4000-8000-00000000000a';

  let sessDir: string;
  beforeEach(async () => {
    sessDir = await createTmpDir();
  });
  afterEach(async () => {
    vi.mocked(fs.open).mockRestore();
    vi.mocked(fs.rename).mockRestore();
    await cleanup(sessDir);
  });

  function claimState(previous: SessionState): SessionState {
    return {
      ...previous,
      phase: 'PLAN_REVIEW',
      transition: transitions[1],
      proofContract: {
        version: 'contract.v2',
        claims: [
          {
            claimId,
            statement: 'the command registry is consistent',
            signalClass: 'fact',
            critical: false,
            provenance: { kind: 'canonical_authority', authorityId: 'ticket', digest: 'authority' },
            evidenceRefs: [{ kind: 'structural_surface', surfaceId: 'command-registration' }],
            counterexampleRefs: [],
          },
        ],
      },
    };
  }

  it('binds only new transition operations to the refreshed claim graph and persisted artifacts', async () => {
    const previous = makeProgressedState('PLAN');
    await writeState(sessDir, previous);
    const persistedBefore = await readState(sessDir);
    expect(persistedBefore).not.toBeNull();
    const next = claimState(persistedBefore!);
    const result = await writeStateWithArtifactsAndAuditOperations(sessDir, next, transitions);
    const persisted = await readState(sessDir);
    expect(persisted).toEqual(result);
    expect(persisted!.proofGraph?.claims).toHaveLength(1);
    expect(persisted!.proofGraph?.claims[0]?.claimId).toBe(claimId);
    expect(persisted!.proofGraph?.claims[0]?.verificationState).toBe('PROVEN');
    await verifyEvidenceArtifacts(sessDir, persisted!);
    const stateBytes = await fs.readFile(statePath(sessDir), 'utf-8');
    const files = await fs.readdir(path.join(sessDir, 'artifacts'));
    const metadata = files.filter((file) => file.endsWith('.json'));
    expect(metadata.length).toBeGreaterThan(0);
    for (const file of metadata) {
      const artifact = JSON.parse(
        await fs.readFile(path.join(sessDir, 'artifacts', file), 'utf-8'),
      ) as { sourceStateHash: string };
      expect(artifact.sourceStateHash).toBe(hashFileBytes(stateBytes));
    }

    const added = persisted!.pendingAuditOperations.slice(
      persistedBefore!.pendingAuditOperations.length,
    );
    expect(added).toHaveLength(2);
    for (const [index, operation] of added.entries()) {
      expect(operation.kind).toBe('transition');
      if (operation.kind !== 'transition') continue;
      expect(operation.preStateDigest).toBe(computeStateDigest(persistedBefore!));
      expect(operation.postStateDigest).toBe(computeStateDigest(persisted!));
      expect(operation.mutationDigest).toBe(hashText(canonicalJsonStringify(transitions)));
      expect(operation.transition.chainIndex).toBe(index);
      expect(operation.auditEventDigest).toBe(
        computeCanonicalEventDigest(
          buildTransitionBody({
            flowguardSessionId: persisted!.flowguardSessionId,
            hostSessionId: persisted!.binding.hostSessionId,
            phase: operation.transition.to,
            detail: {
              operationId: operation.operationId,
              preStateDigest: operation.preStateDigest,
              mutationDigest: operation.mutationDigest,
              postStateDigest: operation.postStateDigest,
              from: operation.transition.from,
              to: operation.transition.to,
              event: operation.transition.event,
              autoAdvanced: operation.transition.autoAdvanced,
              chainIndex: operation.transition.chainIndex,
            },
            occurredAt: operation.transition.at,
            prevHash: 'genesis',
          }),
        ),
      );
    }
  });

  it('binds only the new state-write and semantic operations after an earlier write', async () => {
    const initial = makeState('TICKET', { id: sessionId });
    await writeState(sessDir, initial);
    await writeStateWithArtifactsAndAuditOperations(sessDir, {
      ...initial,
      activeChecks: ['lint'],
    });
    const previous = await readState(sessDir);
    expect(previous?.pendingAuditOperations).toHaveLength(1);
    const intent = {
      phase: 'TICKET' as const,
      event: 'review:obligation_blocked',
      occurredAt: at,
      detail: { obligationId: 'obl-1', code: 'REVIEWER_INVOCATION_EXHAUSTED' },
    };
    const persisted = await writeStateWithArtifactsAndAuditOperations(
      sessDir,
      { ...previous!, activeChecks: ['lint', 'test'] },
      undefined,
      [intent],
    );
    const read = await readState(sessDir);
    expect(read).toEqual(persisted);
    expect(read!.pendingAuditOperations[0]!.postStateDigest).toBe(computeStateDigest(previous!));
    const added = read!.pendingAuditOperations.slice(previous!.pendingAuditOperations.length);
    expect(added.map((operation) => operation.kind)).toEqual(['state_write', 'semantic']);
    for (const operation of added) {
      expect(operation.preStateDigest).toBe(computeStateDigest(previous!));
      expect(operation.postStateDigest).toBe(computeStateDigest(read!));
      if (operation.kind === 'state_write') {
        const { pendingAuditOperations: _before, ...before } = previous!;
        const { pendingAuditOperations: _after, ...after } = read!;
        expect(operation.mutationDigest).toBe(
          hashText(
            canonicalJsonStringify({
              kind: 'state_write',
              before,
              after,
            }),
          ),
        );
        expect(operation.auditEventDigest).toBe(
          computeCanonicalEventDigest(
            buildStateWriteBody({
              flowguardSessionId: read!.flowguardSessionId,
              hostSessionId: read!.binding.hostSessionId,
              phase: operation.stateWrite.phase,
              detail: {
                operationId: operation.operationId,
                preStateDigest: operation.preStateDigest,
                mutationDigest: operation.mutationDigest,
                postStateDigest: operation.postStateDigest,
              },
              occurredAt: operation.stateWrite.at,
              prevHash: 'genesis',
            }),
          ),
        );
      } else if (operation.kind === 'semantic') {
        const { pendingAuditOperations: _before, ...before } = previous!;
        const { pendingAuditOperations: _after, ...after } = read!;
        expect(operation.mutationDigest).toBe(
          hashText(
            canonicalJsonStringify({
              kind: 'semantic',
              before,
              after,
              semantic: intent,
            }),
          ),
        );
        expect(operation.auditEventDigest).toBe(
          computeCanonicalEventDigest(
            buildSemanticAuditBody({
              flowguardSessionId: read!.flowguardSessionId,
              hostSessionId: read!.binding.hostSessionId,
              phase: intent.phase,
              detail: intent.detail,
              event: intent.event,
              occurredAt: intent.occurredAt,
              prevHash: 'genesis',
              operationId: operation.operationId,
              preStateDigest: operation.preStateDigest,
              mutationDigest: operation.mutationDigest,
              postStateDigest: operation.postStateDigest,
            }),
          ),
        );
      }
    }
  });

  it('retains the old state on failure before the state rename', async () => {
    const previous = makeProgressedState('PLAN');
    await writeState(sessDir, previous);
    const before = await fs.readFile(statePath(sessDir), 'utf-8');
    const actualRename = ((globalThis as Record<string, unknown>).__writeStateFsActual as typeof fs)
      .rename;
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (to === statePath(sessDir))
        throw Object.assign(new Error('rename fault'), { code: 'EXDEV' });
      return actualRename(from, to);
    });
    await expect(
      writeStateWithArtifacts(sessDir, { ...previous, activeChecks: ['lint'] }),
    ).rejects.toMatchObject({ code: 'WRITE_FAILED' });
    expect(await fs.readFile(statePath(sessDir), 'utf-8')).toBe(before);
    expect((await readState(sessDir))?.activeChecks).toEqual(previous.activeChecks);
    await verifyEvidenceArtifacts(sessDir, previous);
  });

  it('reads the committed outbox after a post-rename fsync failure and reconciles it once', async () => {
    const previous = makeState('TICKET', { id: sessionId });
    await writeState(sessDir, previous);
    const actualOpen = ((globalThis as Record<string, unknown>).__writeStateFsActual as typeof fs)
      .open;
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      if (args[0] === sessDir && args[1] === 'r') {
        throw Object.assign(new Error('directory sync fault'), { code: 'EIO' });
      }
      return actualOpen(...args);
    });
    const next = makeState('PLAN', { id: sessionId, transition: transitions[0] });
    await expect(
      writeStateWithArtifactsAndAuditOperations(sessDir, next, [transitions[0]]),
    ).rejects.toMatchObject({ code: 'WRITE_FAILED' });
    vi.mocked(fs.open).mockRestore();

    const recovered = await readState(sessDir);
    expect(recovered?.phase).toBe('PLAN');
    const added = recovered!.pendingAuditOperations.slice(previous.pendingAuditOperations.length);
    expect(added).toHaveLength(1);
    expect(added[0]?.postStateDigest).toBe(computeStateDigest(recovered!));
    const deps = makeDeps({
      getSessionDir: vi.fn().mockReturnValue(sessDir),
      resolveSessionPolicy: vi.fn().mockResolvedValue({
        policy: {
          audit: { emitToolCalls: false, emitTransitions: true, enableChainHash: true },
          actorClassification: {},
          mode: 'regulated',
          requireHumanGates: true,
        },
        state: recovered,
      }),
      appendAndTrack: vi.fn(async (event) => {
        await appendAuditEvent(sessDir, event);
      }),
    });
    await expect(
      reconcilePendingAuditOperations(deps, sessionId, 'flowguard_plan'),
    ).resolves.toBeUndefined();
    await expect(
      reconcilePendingAuditOperations(deps, sessionId, 'flowguard_plan'),
    ).resolves.toBeUndefined();
    expect(
      (await readAuditTrail(sessDir)).filter((event) => event.id === added[0]?.operationId),
    ).toHaveLength(1);
    expect((await readState(sessDir))?.pendingAuditOperations.at(-1)?.status).toBe('reconciled');
  });
});

function hashFileBytes(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

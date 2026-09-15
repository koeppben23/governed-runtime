/**
 * @module adapters/workspace/evidence-artifacts.test
 * @description Tests for derived ticket/plan evidence artifact materialization.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, PERF, E2E-SMOKE
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeState, PLAN_EVIDENCE, TICKET } from '../../fixtures.js';
import type { PlanEvidence } from '../../state/evidence.js';
import { makePlanRevision, makePlanRevisionAfter } from '../../state/evidence-test-constants.js';
import { writeState } from '../persistence.js';
import {
  EVIDENCE_ARTIFACTS_DIR,
  materializeEvidenceArtifacts,
  verifyEvidenceArtifacts,
} from './evidence-artifacts.js';

/**
 * Build a lineage-coherent plan revision chained to its predecessor. Artifact
 * identity is the canonical revision identity (`recordDigest`), which includes
 * the minted `revisionId`, so fixtures must model real lineage (contiguous
 * planVersion + `supersedesRecordDigest` chaining).
 */
function planRevision(
  predecessor: PlanEvidence | null,
  input: { body: string; createdAt: string; revisionId?: string },
): PlanEvidence {
  const revisionId = input.revisionId ?? randomUUID();
  return predecessor
    ? makePlanRevisionAfter(predecessor, {
        body: input.body,
        createdAt: input.createdAt,
        revisionId,
      })
    : makePlanRevision({ body: input.body, createdAt: input.createdAt, revisionId });
}

let sessionDir: string;

beforeEach(async () => {
  sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-evidence-'));
});

afterEach(async () => {
  await fs.rm(sessionDir, { recursive: true, force: true });
});

describe('evidence-artifacts', () => {
  describe('HAPPY', () => {
    it('materializes ticket and plan artifacts for a new plan', async () => {
      const state = makeState('PLAN', {
        ticket: TICKET,
        plan: { current: PLAN_EVIDENCE, history: [], reviewCompletion: 'pending' },
      });
      await writeState(sessionDir, state);

      await materializeEvidenceArtifacts(sessionDir, state);

      const artifactsDir = path.join(sessionDir, EVIDENCE_ARTIFACTS_DIR);
      const entries = (await fs.readdir(artifactsDir)).sort();
      expect(entries).toEqual(['plan.v1.json', 'plan.v1.md', 'ticket.v1.json', 'ticket.v1.md']);

      await expect(verifyEvidenceArtifacts(sessionDir, state)).resolves.toBeUndefined();
    });

    it('writes metadata with sourceStateHash and contentHash', async () => {
      const state = makeState('PLAN', {
        ticket: TICKET,
        plan: { current: PLAN_EVIDENCE, history: [], reviewCompletion: 'pending' },
      });
      await writeState(sessionDir, state);
      await materializeEvidenceArtifacts(sessionDir, state);

      const raw = await fs.readFile(
        path.join(sessionDir, EVIDENCE_ARTIFACTS_DIR, 'plan.v1.json'),
        'utf-8',
      );
      const meta = JSON.parse(raw) as { sourceStateHash: string; contentHash: string };
      expect(meta.sourceStateHash).toMatch(/^[0-9a-f]{64}$/);
      expect(meta.contentHash).toBe(PLAN_EVIDENCE.digest);
    });

    it('rejects invalid sourceStateHash format in artifact metadata', async () => {
      const state = makeState('PLAN', {
        ticket: TICKET,
        plan: { current: PLAN_EVIDENCE, history: [], reviewCompletion: 'pending' },
      });
      await writeState(sessionDir, state);
      await materializeEvidenceArtifacts(sessionDir, state);

      const planMetaPath = path.join(sessionDir, EVIDENCE_ARTIFACTS_DIR, 'plan.v1.json');
      const meta = JSON.parse(await fs.readFile(planMetaPath, 'utf-8')) as {
        sourceStateHash: string;
      };
      meta.sourceStateHash = 'not-a-sha256-hash';
      await fs.writeFile(planMetaPath, JSON.stringify(meta, null, 2) + '\n', 'utf-8');

      await expect(verifyEvidenceArtifacts(sessionDir, state)).rejects.toMatchObject({
        code: 'EVIDENCE_ARTIFACT_MISMATCH',
      });
    });
  });

  describe('BAD', () => {
    it('fails verification when expected plan artifact file is missing', async () => {
      const older = planRevision(null, {
        body: '## Plan\n1. Older',
        createdAt: '2026-01-01T00:00:01.000Z',
      });
      const newer = planRevision(older, {
        body: '## Plan\n1. Newer',
        createdAt: '2026-01-01T00:00:02.000Z',
      });
      const state = makeState('PLAN_REVIEW', {
        ticket: TICKET,
        plan: { current: newer, history: [older], reviewCompletion: 'pending' },
      });
      await writeState(sessionDir, state);
      await materializeEvidenceArtifacts(sessionDir, state);

      await fs.rm(path.join(sessionDir, EVIDENCE_ARTIFACTS_DIR, 'plan.v1.json'));

      await expect(verifyEvidenceArtifacts(sessionDir, state)).rejects.toMatchObject({
        code: 'EVIDENCE_ARTIFACT_MISSING',
      });
    });

    it('fails verification when current plan hash mismatches', async () => {
      const state = makeState('PLAN_REVIEW', {
        ticket: TICKET,
        plan: { current: PLAN_EVIDENCE, history: [], reviewCompletion: 'pending' },
      });
      await writeState(sessionDir, state);
      await materializeEvidenceArtifacts(sessionDir, state);

      const badMetaPath = path.join(sessionDir, EVIDENCE_ARTIFACTS_DIR, 'plan.v1.json');
      const meta = JSON.parse(await fs.readFile(badMetaPath, 'utf-8')) as { contentHash: string };
      meta.contentHash = 'wrong-hash';
      await fs.writeFile(badMetaPath, JSON.stringify(meta, null, 2) + '\n', 'utf-8');

      await expect(verifyEvidenceArtifacts(sessionDir, state)).rejects.toMatchObject({
        code: 'EVIDENCE_ARTIFACT_MISMATCH',
      });
    });

    it('fails verification when markdown artifact is tampered', async () => {
      const state = makeState('PLAN_REVIEW', {
        ticket: TICKET,
        plan: { current: PLAN_EVIDENCE, history: [], reviewCompletion: 'pending' },
      });
      await writeState(sessionDir, state);
      await materializeEvidenceArtifacts(sessionDir, state);

      const planMdPath = path.join(sessionDir, EVIDENCE_ARTIFACTS_DIR, 'plan.v1.md');
      await fs.writeFile(planMdPath, '# Plan v1\n\nTampered content\n', 'utf-8');

      await expect(verifyEvidenceArtifacts(sessionDir, state)).rejects.toMatchObject({
        code: 'EVIDENCE_ARTIFACT_MISMATCH',
      });
    });

    it('fails verification when older ticket markdown artifact is tampered', async () => {
      const first = makeState('TICKET', { ticket: TICKET, plan: null });
      await writeState(sessionDir, first);
      await materializeEvidenceArtifacts(sessionDir, first);

      const secondTicket = {
        ...TICKET,
        text: 'Second ticket text',
        digest: 'digest-ticket-v2',
        createdAt: '2026-01-01T00:00:03.000Z',
      };
      const second = makeState('TICKET', { ticket: secondTicket, plan: null });
      await writeState(sessionDir, second);
      await materializeEvidenceArtifacts(sessionDir, second);

      await fs.writeFile(
        path.join(sessionDir, EVIDENCE_ARTIFACTS_DIR, 'ticket.v1.md'),
        '# Ticket v1\n\nTampered\n',
        'utf-8',
      );

      await expect(verifyEvidenceArtifacts(sessionDir, second)).rejects.toMatchObject({
        code: 'EVIDENCE_ARTIFACT_MISMATCH',
      });
    });

    it('fails verification when artifact metadata version mismatches filename version', async () => {
      const state = makeState('PLAN', {
        ticket: TICKET,
        plan: { current: PLAN_EVIDENCE, history: [], reviewCompletion: 'pending' },
      });
      await writeState(sessionDir, state);
      await materializeEvidenceArtifacts(sessionDir, state);

      const planMetaPath = path.join(sessionDir, EVIDENCE_ARTIFACTS_DIR, 'plan.v1.json');
      const meta = JSON.parse(await fs.readFile(planMetaPath, 'utf-8')) as { version: number };
      meta.version = 2;
      await fs.writeFile(planMetaPath, JSON.stringify(meta, null, 2) + '\n', 'utf-8');

      await expect(verifyEvidenceArtifacts(sessionDir, state)).rejects.toMatchObject({
        code: 'EVIDENCE_ARTIFACT_MISMATCH',
      });
    });

    it('fails verification when artifact markdownPath mismatches filename', async () => {
      const state = makeState('PLAN', {
        ticket: TICKET,
        plan: { current: PLAN_EVIDENCE, history: [], reviewCompletion: 'pending' },
      });
      await writeState(sessionDir, state);
      await materializeEvidenceArtifacts(sessionDir, state);

      const planMetaPath = path.join(sessionDir, EVIDENCE_ARTIFACTS_DIR, 'plan.v1.json');
      const meta = JSON.parse(await fs.readFile(planMetaPath, 'utf-8')) as { markdownPath: string };
      meta.markdownPath = 'artifacts/plan.v999.md';
      await fs.writeFile(planMetaPath, JSON.stringify(meta, null, 2) + '\n', 'utf-8');

      await expect(verifyEvidenceArtifacts(sessionDir, state)).rejects.toMatchObject({
        code: 'EVIDENCE_ARTIFACT_MISMATCH',
      });
    });

    it('cleans up newly created files when materialization fails mid-write', async () => {
      const first = makeState('TICKET', { ticket: TICKET, plan: null });
      await writeState(sessionDir, first);
      await materializeEvidenceArtifacts(sessionDir, first);

      const secondTicket = {
        ...TICKET,
        text: 'Second ticket text',
        digest: 'digest-ticket-v2',
        createdAt: '2026-01-01T00:00:03.000Z',
      };
      const second = makeState('TICKET', { ticket: secondTicket, plan: null });
      await writeState(sessionDir, second);

      // Force a mid-write failure: ticket.v2.json already exists with conflicting content.
      await fs.writeFile(
        path.join(sessionDir, EVIDENCE_ARTIFACTS_DIR, 'ticket.v2.json'),
        '{"schemaVersion":"invalid"}\n',
        'utf-8',
      );

      await expect(materializeEvidenceArtifacts(sessionDir, second)).rejects.toMatchObject({
        code: 'EVIDENCE_ARTIFACT_MISMATCH',
      });

      await expect(
        fs.access(path.join(sessionDir, EVIDENCE_ARTIFACTS_DIR, 'ticket.v2.md')),
      ).rejects.toBeDefined();
    });
  });

  describe('CORNER', () => {
    it('materializes full plan version chain from current+history', async () => {
      const v1 = planRevision(null, {
        body: '## Plan\n1. v1',
        createdAt: TICKET.createdAt,
      });
      const v2 = planRevision(v1, {
        body: '## Plan\n1. v2',
        createdAt: '2026-01-01T00:00:01.000Z',
      });
      const v3 = planRevision(v2, {
        body: '## Plan\n1. v3',
        createdAt: '2026-01-01T00:00:02.000Z',
      });
      const state = makeState('PLAN_REVIEW', {
        ticket: TICKET,
        plan: { current: v3, history: [v2, v1], reviewCompletion: 'pending' },
      });
      await writeState(sessionDir, state);
      await materializeEvidenceArtifacts(sessionDir, state);

      const entries = (await fs.readdir(path.join(sessionDir, EVIDENCE_ARTIFACTS_DIR))).sort();
      expect(entries).toContain('plan.v1.json');
      expect(entries).toContain('plan.v2.json');
      expect(entries).toContain('plan.v3.json');
      await expect(verifyEvidenceArtifacts(sessionDir, state)).resolves.toBeUndefined();
    });
  });

  describe('EDGE', () => {
    it('is idempotent when materialized twice for same state', async () => {
      const state = makeState('PLAN', {
        ticket: TICKET,
        plan: { current: PLAN_EVIDENCE, history: [], reviewCompletion: 'pending' },
      });
      await writeState(sessionDir, state);
      await materializeEvidenceArtifacts(sessionDir, state);
      const before = await fs.readFile(
        path.join(sessionDir, EVIDENCE_ARTIFACTS_DIR, 'plan.v1.json'),
        'utf-8',
      );

      await materializeEvidenceArtifacts(sessionDir, state);
      const after = await fs.readFile(
        path.join(sessionDir, EVIDENCE_ARTIFACTS_DIR, 'plan.v1.json'),
        'utf-8',
      );

      expect(after).toBe(before);
    });

    it('creates next ticket version on re-ticket with new digest', async () => {
      const first = makeState('TICKET', { ticket: TICKET, plan: null });
      await writeState(sessionDir, first);
      await materializeEvidenceArtifacts(sessionDir, first);

      const secondTicket = {
        ...TICKET,
        text: 'Second ticket text',
        digest: 'digest-ticket-v2',
        createdAt: '2026-01-01T00:00:03.000Z',
      };
      const second = makeState('TICKET', { ticket: secondTicket, plan: null });
      await writeState(sessionDir, second);
      await materializeEvidenceArtifacts(sessionDir, second);

      const entries = (await fs.readdir(path.join(sessionDir, EVIDENCE_ARTIFACTS_DIR))).sort();
      expect(entries).toContain('ticket.v1.json');
      expect(entries).toContain('ticket.v2.json');
      await expect(verifyEvidenceArtifacts(sessionDir, second)).resolves.toBeUndefined();
    });

    it('does not create ticket.v2 when only non-ticket state changes', async () => {
      const ticketState = makeState('TICKET', { ticket: TICKET, plan: null });
      await writeState(sessionDir, ticketState);
      await materializeEvidenceArtifacts(sessionDir, ticketState);

      const planState = makeState('PLAN', {
        ticket: TICKET,
        plan: { current: PLAN_EVIDENCE, history: [], reviewCompletion: 'pending' },
      });
      await writeState(sessionDir, planState);
      await materializeEvidenceArtifacts(sessionDir, planState);

      const entries = (await fs.readdir(path.join(sessionDir, EVIDENCE_ARTIFACTS_DIR))).sort();
      expect(entries).toEqual(['plan.v1.json', 'plan.v1.md', 'ticket.v1.json', 'ticket.v1.md']);
    });

    it('does not create plan.v2 when phase changes but plan digest stays the same', async () => {
      const planState = makeState('PLAN', {
        ticket: TICKET,
        plan: { current: PLAN_EVIDENCE, history: [], reviewCompletion: 'pending' },
      });
      await writeState(sessionDir, planState);
      await materializeEvidenceArtifacts(sessionDir, planState);

      const validationState = makeState('VALIDATION', {
        ticket: TICKET,
        plan: { current: PLAN_EVIDENCE, history: [], reviewCompletion: 'pending' },
      });
      await writeState(sessionDir, validationState);
      await materializeEvidenceArtifacts(sessionDir, validationState);

      const entries = (await fs.readdir(path.join(sessionDir, EVIDENCE_ARTIFACTS_DIR))).sort();
      expect(entries).toEqual(['plan.v1.json', 'plan.v1.md', 'ticket.v1.json', 'ticket.v1.md']);
    });
  });

  describe('REVISION IDENTITY', () => {
    it('materializes a distinct lineage artifact for an identical-body revision (v1(X) → v2(X))', async () => {
      const body = '## Plan\n1. Unchanged body';
      const artifactsDir = path.join(sessionDir, EVIDENCE_ARTIFACTS_DIR);

      const v1 = planRevision(null, {
        body,
        createdAt: '2026-01-01T00:00:01.000Z',
      });
      const firstState = makeState('PLAN_REVIEW', {
        ticket: TICKET,
        plan: { current: v1, history: [], reviewCompletion: 'pending' },
      });
      await writeState(sessionDir, firstState);
      await materializeEvidenceArtifacts(sessionDir, firstState);

      // Identical body and digest, but a NEW lineage revision: the authority
      // advanced (planVersion 2, supersedes v1), so artifact identity must too.
      const v2 = planRevision(v1, {
        body,
        createdAt: '2026-01-01T00:00:02.000Z',
      });
      const secondState = makeState('PLAN_REVIEW', {
        ticket: TICKET,
        plan: { current: v2, history: [v1], reviewCompletion: 'pending' },
      });
      await writeState(sessionDir, secondState);
      await materializeEvidenceArtifacts(sessionDir, secondState);

      const entries = (await fs.readdir(artifactsDir)).sort();
      expect(entries).toContain('plan.v1.json');
      expect(entries).toContain('plan.v2.json');

      const metaV1 = JSON.parse(
        await fs.readFile(path.join(artifactsDir, 'plan.v1.json'), 'utf-8'),
      ) as { contentHash: string; createdAt: string; version: number };
      const metaV2 = JSON.parse(
        await fs.readFile(path.join(artifactsDir, 'plan.v2.json'), 'utf-8'),
      ) as { contentHash: string; createdAt: string; version: number };
      expect(metaV1).toMatchObject({
        version: 1,
        contentHash: v1.digest,
        createdAt: '2026-01-01T00:00:01.000Z',
      });
      expect(metaV2).toMatchObject({
        version: 2,
        contentHash: v2.digest,
        createdAt: '2026-01-01T00:00:02.000Z',
      });
      expect(metaV2.contentHash).toBe(metaV1.contentHash);
      expect(v2.recordDigest).not.toBe(v1.recordDigest);

      await expect(verifyEvidenceArtifacts(sessionDir, secondState)).resolves.toBeUndefined();
    });

    it('catches up multiple missing lineage revisions in one materialization', async () => {
      const v1 = planRevision(null, {
        body: '## Plan\n1. v1',
        createdAt: '2026-01-01T00:00:01.000Z',
      });
      const artifactsDir = path.join(sessionDir, EVIDENCE_ARTIFACTS_DIR);

      const firstState = makeState('PLAN_REVIEW', {
        ticket: TICKET,
        plan: { current: v1, history: [], reviewCompletion: 'pending' },
      });
      await writeState(sessionDir, firstState);
      await materializeEvidenceArtifacts(sessionDir, firstState);

      const v2 = planRevision(v1, {
        body: '## Plan\n1. v2',
        createdAt: '2026-01-01T00:00:02.000Z',
      });
      const v3 = planRevision(v2, {
        body: '## Plan\n1. v3',
        createdAt: '2026-01-01T00:00:03.000Z',
      });
      const thirdState = makeState('PLAN_REVIEW', {
        ticket: TICKET,
        plan: { current: v3, history: [v2, v1], reviewCompletion: 'pending' },
      });
      await writeState(sessionDir, thirdState);
      await materializeEvidenceArtifacts(sessionDir, thirdState);

      const entries = (await fs.readdir(artifactsDir)).sort();
      expect(entries).toEqual([
        'plan.v1.json',
        'plan.v1.md',
        'plan.v2.json',
        'plan.v2.md',
        'plan.v3.json',
        'plan.v3.md',
        'ticket.v1.json',
        'ticket.v1.md',
      ]);
      await expect(verifyEvidenceArtifacts(sessionDir, thirdState)).resolves.toBeUndefined();
    });

    it('materializes a new lineage artifact when a re-traversal starts a fresh v1', async () => {
      const artifactsDir = path.join(sessionDir, EVIDENCE_ARTIFACTS_DIR);
      const firstLineageV1 = planRevision(null, {
        body: '## Plan\n1. First lineage',
        createdAt: '2026-01-01T00:00:01.000Z',
      });
      const firstState = makeState('PLAN_REVIEW', {
        ticket: TICKET,
        plan: { current: firstLineageV1, history: [], reviewCompletion: 'pending' },
      });
      await writeState(sessionDir, firstState);
      await materializeEvidenceArtifacts(sessionDir, firstState);

      // Re-traversal (EVIDENCE_REVIEW reject → TICKET → new plan): the plan
      // authority restarts at v1 with a new lineage while plan.v1 already
      // exists from the superseded lineage.
      const secondLineageV1 = planRevision(null, {
        body: '## Plan\n1. Second lineage',
        createdAt: '2026-01-02T00:00:01.000Z',
      });
      const secondState = makeState('PLAN_REVIEW', {
        ticket: { ...TICKET, text: 'Second attempt', digest: 'digest-ticket-2' },
        plan: { current: secondLineageV1, history: [], reviewCompletion: 'pending' },
      });
      await writeState(sessionDir, secondState);
      await materializeEvidenceArtifacts(sessionDir, secondState);

      const entries = (await fs.readdir(artifactsDir)).sort();
      expect(entries).toContain('plan.v1.json');
      expect(entries).toContain('plan.v2.json');
      const metaV2 = JSON.parse(
        await fs.readFile(path.join(artifactsDir, 'plan.v2.json'), 'utf-8'),
      ) as { contentHash: string; recordDigest: string };
      expect(metaV2.contentHash).toBe(secondLineageV1.digest);
      expect(metaV2.recordDigest).toBe(secondLineageV1.recordDigest);
      await expect(verifyEvidenceArtifacts(sessionDir, secondState)).resolves.toBeUndefined();
    });

    it('distinguishes identical content/version/timestamp lineages by revisionId', async () => {
      const artifactsDir = path.join(sessionDir, EVIDENCE_ARTIFACTS_DIR);
      // Same body, planVersion 1, no predecessor, same timestamp: the minted
      // `revisionId` is inside the record digest, so the two revision
      // instances still carry DISTINCT record digests and artifacts.
      const firstInstance = planRevision(null, {
        body: '## Plan\n1. Same body',
        createdAt: '2026-01-01T00:00:01.000Z',
      });
      const firstState = makeState('PLAN_REVIEW', {
        ticket: TICKET,
        plan: { current: firstInstance, history: [], reviewCompletion: 'pending' },
      });
      await writeState(sessionDir, firstState);
      await materializeEvidenceArtifacts(sessionDir, firstState);

      const secondInstance = planRevision(null, {
        body: '## Plan\n1. Same body',
        createdAt: '2026-01-01T00:00:01.000Z',
      });
      expect(secondInstance.revisionId).not.toBe(firstInstance.revisionId);
      expect(secondInstance.recordDigest).not.toBe(firstInstance.recordDigest);
      const secondState = makeState('PLAN_REVIEW', {
        ticket: { ...TICKET, text: 'Second attempt', digest: 'digest-ticket-3' },
        plan: { current: secondInstance, history: [], reviewCompletion: 'pending' },
      });
      await writeState(sessionDir, secondState);
      await materializeEvidenceArtifacts(sessionDir, secondState);

      const metaV2 = JSON.parse(
        await fs.readFile(path.join(artifactsDir, 'plan.v2.json'), 'utf-8'),
      ) as { createdAt: string; recordDigest: string };
      expect(metaV2.createdAt).toBe('2026-01-01T00:00:01.000Z');
      expect(metaV2.recordDigest).toBe(secondInstance.recordDigest);
      await expect(verifyEvidenceArtifacts(sessionDir, secondState)).resolves.toBeUndefined();
    });

    it('fails verification when one revision identity is materialized twice', async () => {
      const state = makeState('PLAN_REVIEW', {
        ticket: TICKET,
        plan: { current: PLAN_EVIDENCE, history: [], reviewCompletion: 'pending' },
      });
      await writeState(sessionDir, state);
      await materializeEvidenceArtifacts(sessionDir, state);

      const artifactsDir = path.join(sessionDir, EVIDENCE_ARTIFACTS_DIR);
      const meta = JSON.parse(
        await fs.readFile(path.join(artifactsDir, 'plan.v1.json'), 'utf-8'),
      ) as Record<string, unknown>;
      await fs.writeFile(
        path.join(artifactsDir, 'plan.v2.json'),
        JSON.stringify(
          { ...meta, version: 2, markdownPath: `${EVIDENCE_ARTIFACTS_DIR}/plan.v2.md` },
          null,
          2,
        ) + '\n',
        'utf-8',
      );
      await fs.copyFile(
        path.join(artifactsDir, 'plan.v1.md'),
        path.join(artifactsDir, 'plan.v2.md'),
      );

      await expect(verifyEvidenceArtifacts(sessionDir, state)).rejects.toMatchObject({
        code: 'EVIDENCE_ARTIFACT_MISMATCH',
      });
    });

    it('fails verification when an artifact timestamp does not match its revision', async () => {
      const state = makeState('PLAN_REVIEW', {
        ticket: TICKET,
        plan: { current: PLAN_EVIDENCE, history: [], reviewCompletion: 'pending' },
      });
      await writeState(sessionDir, state);
      await materializeEvidenceArtifacts(sessionDir, state);

      const planMetaPath = path.join(sessionDir, EVIDENCE_ARTIFACTS_DIR, 'plan.v1.json');
      const meta = JSON.parse(await fs.readFile(planMetaPath, 'utf-8')) as { createdAt: string };
      meta.createdAt = '2020-01-01T00:00:00.000Z';
      await fs.writeFile(planMetaPath, JSON.stringify(meta, null, 2) + '\n', 'utf-8');

      await expect(verifyEvidenceArtifacts(sessionDir, state)).rejects.toMatchObject({
        code: 'EVIDENCE_ARTIFACT_MISMATCH',
      });
    });

    it('fails closed on a non-contiguous plan lineage at the state boundary', async () => {
      const v1 = planRevision(null, {
        body: '## Plan\n1. v1',
        createdAt: '2026-01-01T00:00:01.000Z',
      });
      const v3 = {
        ...planRevision(v1, {
          body: '## Plan\n1. v3',
          createdAt: '2026-01-01T00:00:03.000Z',
        }),
        planVersion: 3,
      };
      const state = makeState('PLAN_REVIEW', {
        ticket: TICKET,
        plan: { current: v3, history: [v1], reviewCompletion: 'pending' },
      });

      // Lineage coherence is enforced by the PlanRecord refinement: the
      // artifact layer never sees an incoherent chain.
      await expect(writeState(sessionDir, state)).rejects.toMatchObject({
        code: 'SCHEMA_VALIDATION_FAILED',
      });
    });
  });

  describe('PERF', () => {
    it('verifies artifact set quickly (p95 < 120ms over 20 runs)', async () => {
      const v1 = planRevision(null, {
        body: '## Plan\n1. v1',
        createdAt: '2026-01-01T00:00:01.000Z',
      });
      const v2 = planRevision(v1, {
        body: '## Plan\n1. v2',
        createdAt: '2026-01-01T00:00:02.000Z',
      });
      const v3 = planRevision(v2, {
        body: '## Plan\n1. v3',
        createdAt: '2026-01-01T00:00:03.000Z',
      });
      const state = makeState('PLAN_REVIEW', {
        ticket: TICKET,
        plan: { current: v3, history: [v2, v1], reviewCompletion: 'pending' },
      });
      await writeState(sessionDir, state);
      await materializeEvidenceArtifacts(sessionDir, state);

      const samples: number[] = [];
      for (let i = 0; i < 20; i += 1) {
        const start = performance.now();
        await verifyEvidenceArtifacts(sessionDir, state);
        samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      const p95 = samples[Math.floor(samples.length * 0.95)] ?? Number.POSITIVE_INFINITY;
      expect(p95).toBeLessThan(process.platform === 'win32' ? 500 : 120);
    });
  });

  describe('E2E-SMOKE', () => {
    it('supports ticket -> plan transition artifacts in one session directory', async () => {
      const ticketState = makeState('TICKET', { ticket: TICKET, plan: null });
      await writeState(sessionDir, ticketState);
      await materializeEvidenceArtifacts(sessionDir, ticketState);

      const planState = makeState('PLAN', {
        ticket: TICKET,
        plan: { current: PLAN_EVIDENCE, history: [], reviewCompletion: 'pending' },
      });
      await writeState(sessionDir, planState);
      await materializeEvidenceArtifacts(sessionDir, planState);

      await expect(verifyEvidenceArtifacts(sessionDir, planState)).resolves.toBeUndefined();
      const entries = (await fs.readdir(path.join(sessionDir, EVIDENCE_ARTIFACTS_DIR))).sort();
      expect(entries).toEqual(['plan.v1.json', 'plan.v1.md', 'ticket.v1.json', 'ticket.v1.md']);
    });
  });

  describe('COVERAGE', () => {
    it('fails verification when plan history artifact is missing', async () => {
      const v1 = planRevision(null, {
        body: '## Plan\n1. v1',
        createdAt: '2026-01-01T00:00:01.000Z',
      });
      const v2 = planRevision(v1, {
        body: '## Plan\n1. v2',
        createdAt: '2026-01-01T00:00:02.000Z',
      });
      const v3 = planRevision(v2, {
        body: '## Plan\n1. v3',
        createdAt: '2026-01-01T00:00:03.000Z',
      });
      const state = makeState('PLAN_REVIEW', {
        ticket: TICKET,
        plan: { current: v3, history: [v2, v1], reviewCompletion: 'pending' },
      });
      await writeState(sessionDir, state);
      await materializeEvidenceArtifacts(sessionDir, state);

      await fs.rm(path.join(sessionDir, EVIDENCE_ARTIFACTS_DIR, 'plan.v1.json'));

      await expect(verifyEvidenceArtifacts(sessionDir, state)).rejects.toMatchObject({
        code: 'EVIDENCE_ARTIFACT_MISSING',
      });
    });

    it('fails verification when plan history artifact has wrong digest', async () => {
      const v1 = planRevision(null, {
        body: '## Plan\n1. v1',
        createdAt: '2026-01-01T00:00:01.000Z',
      });
      const v2 = planRevision(v1, {
        body: '## Plan\n1. v2',
        createdAt: '2026-01-01T00:00:02.000Z',
      });
      const state = makeState('PLAN_REVIEW', {
        ticket: TICKET,
        plan: { current: v2, history: [v1], reviewCompletion: 'pending' },
      });
      await writeState(sessionDir, state);
      await materializeEvidenceArtifacts(sessionDir, state);

      const v1MetaPath = path.join(sessionDir, EVIDENCE_ARTIFACTS_DIR, 'plan.v1.json');
      const meta = JSON.parse(await fs.readFile(v1MetaPath, 'utf-8')) as { contentHash: string };
      meta.contentHash = 'wrong-digest';
      await fs.writeFile(v1MetaPath, JSON.stringify(meta, null, 2) + '\n', 'utf-8');

      await expect(verifyEvidenceArtifacts(sessionDir, state)).rejects.toMatchObject({
        code: 'EVIDENCE_ARTIFACT_MISMATCH',
      });
    });

    it('fails verification when plan missing sourceStateHash', async () => {
      const state = makeState('PLAN', {
        ticket: TICKET,
        plan: { current: PLAN_EVIDENCE, history: [], reviewCompletion: 'pending' },
      });
      await writeState(sessionDir, state);
      await materializeEvidenceArtifacts(sessionDir, state);

      const planMetaPath = path.join(sessionDir, EVIDENCE_ARTIFACTS_DIR, 'plan.v1.json');
      const meta = JSON.parse(await fs.readFile(planMetaPath, 'utf-8')) as {
        sourceStateHash?: string;
      };
      delete meta.sourceStateHash;
      await fs.writeFile(planMetaPath, JSON.stringify(meta, null, 2) + '\n', 'utf-8');

      await expect(verifyEvidenceArtifacts(sessionDir, state)).rejects.toMatchObject({
        code: 'EVIDENCE_ARTIFACT_MISMATCH',
      });
    });

    it('fails verification when ticket has mismatched contentHash', async () => {
      const state = makeState('TICKET', { ticket: TICKET, plan: null });
      await writeState(sessionDir, state);
      await materializeEvidenceArtifacts(sessionDir, state);

      const ticketMetaPath = path.join(sessionDir, EVIDENCE_ARTIFACTS_DIR, 'ticket.v1.json');
      const meta = JSON.parse(await fs.readFile(ticketMetaPath, 'utf-8')) as {
        contentHash: string;
      };
      meta.contentHash = 'wrong-digest';
      await fs.writeFile(ticketMetaPath, JSON.stringify(meta, null, 2) + '\n', 'utf-8');

      await expect(verifyEvidenceArtifacts(sessionDir, state)).rejects.toMatchObject({
        code: 'EVIDENCE_ARTIFACT_MISMATCH',
      });
    });

    it('materializes plan even when ticket is null', async () => {
      const state = makeState('PLAN', {
        ticket: null,
        plan: { current: PLAN_EVIDENCE, history: [], reviewCompletion: 'pending' },
      });
      await writeState(sessionDir, state);

      await materializeEvidenceArtifacts(sessionDir, state);

      const entries = (await fs.readdir(path.join(sessionDir, EVIDENCE_ARTIFACTS_DIR))).sort();
      expect(entries).toEqual(['plan.v1.json', 'plan.v1.md']);
    });

    it('materializes ticket even when plan is null', async () => {
      const state = makeState('TICKET', { ticket: TICKET, plan: null });
      await writeState(sessionDir, state);

      await materializeEvidenceArtifacts(sessionDir, state);

      const entries = (await fs.readdir(path.join(sessionDir, EVIDENCE_ARTIFACTS_DIR))).sort();
      expect(entries).toEqual(['ticket.v1.json', 'ticket.v1.md']);
    });
  });
});

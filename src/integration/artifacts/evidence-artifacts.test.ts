/**
 * @module integration/artifacts/evidence-artifacts.test
 * @description Tests for derived ticket/plan evidence artifact materialization.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, PERF, E2E-SMOKE
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { makeState, PLAN_EVIDENCE, TICKET } from '../../__fixtures__';
import { writeState } from '../../adapters/persistence';
import {
  EVIDENCE_ARTIFACTS_DIR,
  materializeEvidenceArtifacts,
  verifyEvidenceArtifacts,
} from './evidence-artifacts';

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
        plan: { current: PLAN_EVIDENCE, history: [] },
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
        plan: { current: PLAN_EVIDENCE, history: [] },
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
        plan: { current: PLAN_EVIDENCE, history: [] },
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
      const older = { ...PLAN_EVIDENCE, body: '## Plan\n1. Older', digest: 'digest-plan-v1' };
      const newer = { ...PLAN_EVIDENCE, body: '## Plan\n1. Newer', digest: 'digest-plan-v2' };
      const state = makeState('PLAN_REVIEW', {
        ticket: TICKET,
        plan: { current: newer, history: [older] },
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
        plan: { current: PLAN_EVIDENCE, history: [] },
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
        plan: { current: PLAN_EVIDENCE, history: [] },
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
        plan: { current: PLAN_EVIDENCE, history: [] },
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
        plan: { current: PLAN_EVIDENCE, history: [] },
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
      const v1 = {
        ...PLAN_EVIDENCE,
        body: '## Plan\n1. v1',
        digest: 'digest-v1',
        createdAt: TICKET.createdAt,
      };
      const v2 = {
        ...PLAN_EVIDENCE,
        body: '## Plan\n1. v2',
        digest: 'digest-v2',
        createdAt: '2026-01-01T00:00:01.000Z',
      };
      const v3 = {
        ...PLAN_EVIDENCE,
        body: '## Plan\n1. v3',
        digest: 'digest-v3',
        createdAt: '2026-01-01T00:00:02.000Z',
      };
      const state = makeState('PLAN_REVIEW', {
        ticket: TICKET,
        plan: { current: v3, history: [v2, v1] },
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
        plan: { current: PLAN_EVIDENCE, history: [] },
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
        plan: { current: PLAN_EVIDENCE, history: [] },
      });
      await writeState(sessionDir, planState);
      await materializeEvidenceArtifacts(sessionDir, planState);

      const entries = (await fs.readdir(path.join(sessionDir, EVIDENCE_ARTIFACTS_DIR))).sort();
      expect(entries).toEqual(['plan.v1.json', 'plan.v1.md', 'ticket.v1.json', 'ticket.v1.md']);
    });

    it('does not create plan.v2 when phase changes but plan digest stays the same', async () => {
      const planState = makeState('PLAN', {
        ticket: TICKET,
        plan: { current: PLAN_EVIDENCE, history: [] },
      });
      await writeState(sessionDir, planState);
      await materializeEvidenceArtifacts(sessionDir, planState);

      const validationState = makeState('VALIDATION', {
        ticket: TICKET,
        plan: { current: PLAN_EVIDENCE, history: [] },
      });
      await writeState(sessionDir, validationState);
      await materializeEvidenceArtifacts(sessionDir, validationState);

      const entries = (await fs.readdir(path.join(sessionDir, EVIDENCE_ARTIFACTS_DIR))).sort();
      expect(entries).toEqual(['plan.v1.json', 'plan.v1.md', 'ticket.v1.json', 'ticket.v1.md']);
    });
  });

  describe('PERF', () => {
    it('verifies artifact set quickly (p95 < 120ms over 20 runs)', async () => {
      const v1 = { ...PLAN_EVIDENCE, body: '## Plan\n1. v1', digest: 'digest-v1' };
      const v2 = { ...PLAN_EVIDENCE, body: '## Plan\n1. v2', digest: 'digest-v2' };
      const v3 = { ...PLAN_EVIDENCE, body: '## Plan\n1. v3', digest: 'digest-v3' };
      const state = makeState('PLAN_REVIEW', {
        ticket: TICKET,
        plan: { current: v3, history: [v2, v1] },
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
      expect(p95).toBeLessThan(120);
    });
  });

  describe('E2E-SMOKE', () => {
    it('supports ticket -> plan transition artifacts in one session directory', async () => {
      const ticketState = makeState('TICKET', { ticket: TICKET, plan: null });
      await writeState(sessionDir, ticketState);
      await materializeEvidenceArtifacts(sessionDir, ticketState);

      const planState = makeState('PLAN', {
        ticket: TICKET,
        plan: { current: PLAN_EVIDENCE, history: [] },
      });
      await writeState(sessionDir, planState);
      await materializeEvidenceArtifacts(sessionDir, planState);

      await expect(verifyEvidenceArtifacts(sessionDir, planState)).resolves.toBeUndefined();
      const entries = (await fs.readdir(path.join(sessionDir, EVIDENCE_ARTIFACTS_DIR))).sort();
      expect(entries).toEqual(['plan.v1.json', 'plan.v1.md', 'ticket.v1.json', 'ticket.v1.md']);
    });
  });
});

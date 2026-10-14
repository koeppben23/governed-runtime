import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeState, withTamperedPolicySnapshot } from '../fixtures.js';
import { assessPersistedStateDocument, readState, writeState, statePath } from './persistence.js';
import { classifyStateMember } from './workspace/upgrade-preflight.js';
import { computePolicySnapshotHash, PolicySnapshotSchema } from '../state/evidence-policy.js';
import type { PolicySnapshot } from '../state/evidence-policy.js';

/**
 * Every executable policy authority whose silent change would weaken
 * governance. Each edit keeps the snapshot structurally valid so only the
 * content digest can detect it.
 */
const TAMPER_EDITS: ReadonlyArray<readonly [string, Partial<Omit<PolicySnapshot, 'hash'>>]> = [
  ['requireHumanGates', { requireHumanGates: false }],
  ['allowSelfApproval', { allowSelfApproval: true }],
  ['allowReducedCeremony', { allowReducedCeremony: true }],
  ['minimumActorAssuranceForApproval', { minimumActorAssuranceForApproval: 'best_effort' }],
  ['mode', { mode: 'solo' }],
  ['riskTriggerPaths', { riskTriggerPaths: [] }],
];

describe('frozen policy integrity at the canonical persistence boundary', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'fg-policy-integrity-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it.each(TAMPER_EDITS)(
    'rejects %s tampering without classifying v11 as an obsolete version',
    async (_field, edit) => {
      const base = makeState('IMPLEMENTATION', {
        policySnapshot: {
          ...makeState().policySnapshot,
          mode: 'regulated',
          requireHumanGates: true,
          allowSelfApproval: false,
          allowReducedCeremony: false,
          minimumActorAssuranceForApproval: 'idp_verified',
          riskTriggerPaths: [{ trigger: 'state_integrity', pattern: 'src/main/java/state/**' }],
        },
      });
      const changed = withTamperedPolicySnapshot(base, edit);
      // The edit must actually change the executable content; otherwise the
      // test would prove nothing.
      expect(computePolicySnapshotHash(changed.policySnapshot)).not.toBe(
        changed.policySnapshot.hash,
      );
      // The structural schema stays permissive; the canonical persistence
      // boundary classifies the mismatch as an integrity failure.
      expect(PolicySnapshotSchema.safeParse(changed.policySnapshot).success).toBe(true);
      expect(assessPersistedStateDocument(changed).kind).toBe('integrity_mismatch');
      await expect(writeState(directory, changed)).rejects.toMatchObject({
        code: 'POLICY_SNAPSHOT_INTEGRITY_MISMATCH',
      });
      await writeFile(statePath(directory), JSON.stringify(changed));
      await expect(readState(directory)).rejects.toMatchObject({
        code: 'POLICY_SNAPSHOT_INTEGRITY_MISMATCH',
      });
      expect(classifyStateMember({ kind: 'ok', content: JSON.stringify(changed) })).toBe('invalid');
    },
  );

  it('keeps version incompatibility distinct from current-contract integrity failure', () => {
    expect(assessPersistedStateDocument({ ...makeState(), schemaVersion: 'v10' }).kind).toBe(
      'incompatible',
    );
    expect(assessPersistedStateDocument(makeState()).kind).toBe('compatible');
  });

  it('fixture contract: a makeState policy override authors a matching digest, the tamper helper never does', () => {
    const authored = makeState('PLAN', {
      policySnapshot: { ...makeState().policySnapshot, requireHumanGates: false },
    });
    expect(computePolicySnapshotHash(authored.policySnapshot)).toBe(authored.policySnapshot.hash);
    const tampered = withTamperedPolicySnapshot(makeState('PLAN'), { requireHumanGates: false });
    expect(computePolicySnapshotHash(tampered.policySnapshot)).not.toBe(
      tampered.policySnapshot.hash,
    );
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeState } from '../fixtures.js';
import { assessPersistedStateDocument, readState, writeState, statePath } from './persistence.js';
import { classifyStateMember } from './workspace/upgrade-preflight.js';
import { PolicySnapshotSchema } from '../state/evidence-policy.js';

describe('frozen policy integrity at the canonical persistence boundary', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'fg-policy-integrity-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  it.each(['requireHumanGates', 'allowSelfApproval', 'allowReducedCeremony'] as const)(
    'rejects %s tampering without classifying v11 as an obsolete version',
    async (field) => {
      const state = makeState();
      const changed = {
        ...state,
        policySnapshot: { ...state.policySnapshot, [field]: !state.policySnapshot[field] },
      };
      expect(PolicySnapshotSchema.safeParse(changed.policySnapshot).success).toBe(false);
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
});

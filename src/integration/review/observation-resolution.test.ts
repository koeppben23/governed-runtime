import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeState } from '../../fixtures.js';
import { readState } from '../../adapters/persistence.js';
import { createReviewAttempt, createReviewObligation, freezeReviewMaterial } from './assurance.js';
import { mintObservationCapability } from './attempt-lifecycle.js';

const fixture = vi.hoisted(() => ({ root: '' }));

vi.mock('../../adapters/workspace/index.js', () => ({
  sessionDir: (fingerprint: string, sessionId: string) =>
    path.join(fixture.root, fingerprint, 'sessions', sessionId),
}));

afterEach(async () => {
  if (fixture.root) await fs.rm(fixture.root, { recursive: true, force: true });
  fixture.root = '';
});

describe('resolveAttemptByCapability', () => {
  it('skips non-directory session-root entries without reading them as state', async () => {
    fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-observation-resolution-'));
    const fingerprint = 'ab'.repeat(12);
    const sessions = path.join(fixture.root, fingerprint, 'sessions');
    await fs.mkdir(sessions, { recursive: true });
    await fs.writeFile(path.join(sessions, 'child-transport-artifact'), 'not a directory', 'utf8');

    const obligation = createReviewObligation({
      obligationType: 'implement',
      iteration: 1,
      planVersion: 1,
      subjectDigest: 'implementation-digest',
      reviewMaterial: freezeReviewMaterial('implementation material', 'implementation-digest'),
      reviewSubjectScope: { kind: 'implementation', implementationDigest: 'implementation-digest' },
      now: '2026-01-01T00:00:00.000Z',
    });
    const capability = mintObservationCapability();
    const attempt = createReviewAttempt({
      obligationId: obligation.obligationId,
      obligationType: 'implement',
      subjectDigest: obligation.subjectDigest,
      ordinal: 1,
      origin: { kind: 'initial' },
      repositoryDiscovery: { kind: 'not_applicable' },
      observationCapability: capability,
      now: '2026-01-01T00:00:00.000Z',
    });
    const parentSessionId = '11111111-1111-4111-8111-111111111111';
    const parent = path.join(sessions, parentSessionId);
    await fs.mkdir(parent);
    await fs.writeFile(
      path.join(parent, 'session-state.json'),
      JSON.stringify({
        ...makeState('IMPL_REVIEW'),
        reviewAssurance: {
          assuranceSchemaVersion: 'review-assurance.v6',
          obligations: [obligation],
          invocations: [],
          attempts: [attempt],
          dispatches: [],
        },
      }),
      'utf8',
    );
    expect(await readState(parent)).not.toBeNull();

    const { resolveAttemptByCapability } = await import('./observation-resolution.js');
    const { sessionDir } = await import('../../adapters/workspace/index.js');
    expect(sessionDir(fingerprint, parentSessionId)).toBe(parent);
    await expect(
      resolveAttemptByCapability({ workspaceHome: fixture.root, fingerprint, capability }),
    ).resolves.toMatchObject({
      sessionId: parentSessionId,
      attempt: { attemptId: attempt.attemptId },
    });
  });
});

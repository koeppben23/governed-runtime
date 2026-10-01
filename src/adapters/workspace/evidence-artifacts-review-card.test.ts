/**
 * @module adapters/workspace/evidence-artifacts-review-card.test
 * @description Tests for materializeReviewCardArtifact.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { materializeReviewCardArtifact } from './evidence-artifacts.js';
import { makeState } from '../../fixtures.js';
import { hashText } from '../../shared/hashing.js';

describe('materializeReviewCardArtifact', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flowguard-review-card-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const state = makeState('PEER_REVIEW_COMPLETE');
  const stateHash = hashText(JSON.stringify(state, null, 2) + '\n');

  it('writes .md and .json artifacts with digest-based filename', async () => {
    const result = await materializeReviewCardArtifact(tmpDir, 'review-report-card', '# Report', {
      state,
      contentDigest: 'obligation-uuid',
      stateHash,
    });
    expect(result).toBeNull();

    const artifactsDir = path.join(tmpDir, 'artifacts');
    const md = await fs.readFile(
      path.join(artifactsDir, 'review-report-card.obligation-uuid.md'),
      'utf-8',
    );
    expect(md).toContain('# Report');

    const json = await fs.readFile(
      path.join(artifactsDir, 'review-report-card.obligation-uuid.json'),
      'utf-8',
    );
    const meta = JSON.parse(json);
    expect(meta.artifactType).toBe('review-report-card');
    expect(meta.derived).toBe(true);
    expect(meta.source).toBe('presentation');
    expect(meta.markdownSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(meta.stateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(meta.contentDigest).toBe('obligation-uuid');
  });

  it('is idempotent — same markdown and digest returns null (no-op)', async () => {
    await materializeReviewCardArtifact(tmpDir, 'review-report-card', '# Report', {
      state,
      contentDigest: 'digest-1',
      stateHash,
    });
    const result = await materializeReviewCardArtifact(tmpDir, 'review-report-card', '# Report', {
      state,
      contentDigest: 'digest-1',
      stateHash,
    });
    expect(result).toBeNull();
  });

  it('rejects different markdown for same digest (immutable)', async () => {
    await materializeReviewCardArtifact(tmpDir, 'review-report-card', '# Report', {
      state,
      contentDigest: 'digest-2',
      stateHash,
    });
    const result = await materializeReviewCardArtifact(
      tmpDir,
      'review-report-card',
      '# Different',
      { state, contentDigest: 'digest-2', stateHash },
    );
    expect(result).not.toBeNull();
    expect(result?.code).toBe('REVIEW_CARD_ARTIFACT_IMMUTABLE');

    const artifactsDir = path.join(tmpDir, 'artifacts');
    const md = await fs.readFile(
      path.join(artifactsDir, 'review-report-card.digest-2.md'),
      'utf-8',
    );
    expect(md).toContain('# Report');
  });

  it('different digests create separate files (no staleness)', async () => {
    const r1 = await materializeReviewCardArtifact(tmpDir, 'plan-review-card', '# Card v1', {
      state,
      contentDigest: 'digest-A',
      stateHash,
    });
    expect(r1).toBeNull();
    const r2 = await materializeReviewCardArtifact(tmpDir, 'plan-review-card', '# Card v2', {
      state,
      contentDigest: 'digest-B',
      stateHash,
    });
    expect(r2).toBeNull();

    const artifactsDir = path.join(tmpDir, 'artifacts');
    expect(
      await fs.readFile(path.join(artifactsDir, 'plan-review-card.digest-A.md'), 'utf-8'),
    ).toContain('# Card v1');
    expect(
      await fs.readFile(path.join(artifactsDir, 'plan-review-card.digest-B.md'), 'utf-8'),
    ).toContain('# Card v2');
  });

  it('metadata includes contentDigest in the JSON', async () => {
    await materializeReviewCardArtifact(tmpDir, 'review-report-card', '# R', {
      state,
      contentDigest: 'uuid-123',
      stateHash,
    });
    const json = JSON.parse(
      await fs.readFile(
        path.join(tmpDir, 'artifacts', 'review-report-card.uuid-123.json'),
        'utf-8',
      ),
    );
    expect(json.markdownSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(json.stateHash).toBeDefined();
  });
});

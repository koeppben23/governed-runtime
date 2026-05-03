/**
 * @module adapters/workspace/evidence-artifacts-review-card.test
 * @description Tests for materializeReviewCardArtifact.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { materializeReviewCardArtifact } from './evidence-artifacts.js';
import { makeState } from '../../__fixtures__.js';

describe('materializeReviewCardArtifact', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flowguard-review-card-'));
    // Create a minimal session-state.json for hashFile to read.
    await fs.writeFile(
      path.join(tmpDir, 'session-state.json'),
      JSON.stringify({ id: 'test-session' }),
      'utf-8',
    );
    await fs.mkdir(tmpDir, { recursive: true });
    // Create a minimal session-state.json for hashFile to read.
    await fs.writeFile(
      path.join(tmpDir, 'session-state.json'),
      JSON.stringify({ id: 'test-session' }),
      'utf-8',
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const state = makeState('REVIEW_COMPLETE');

  it('writes .md and .json artifacts with digest-based filename', async () => {
    const result = await materializeReviewCardArtifact(
      tmpDir,
      'review-report-card',
      '# Report',
      state,
      'obligation-uuid',
    );
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
    await materializeReviewCardArtifact(
      tmpDir,
      'review-report-card',
      '# Report',
      state,
      'digest-1',
    );
    const result = await materializeReviewCardArtifact(
      tmpDir,
      'review-report-card',
      '# Report',
      state,
      'digest-1',
    );
    expect(result).toBeNull();
  });

  it('rejects different markdown for same digest (immutable)', async () => {
    await materializeReviewCardArtifact(
      tmpDir,
      'review-report-card',
      '# Report',
      state,
      'digest-2',
    );
    const result = await materializeReviewCardArtifact(
      tmpDir,
      'review-report-card',
      '# Different',
      state,
      'digest-2',
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
    const r1 = await materializeReviewCardArtifact(
      tmpDir,
      'plan-review-card',
      '# Card v1',
      state,
      'digest-A',
    );
    expect(r1).toBeNull();
    const r2 = await materializeReviewCardArtifact(
      tmpDir,
      'plan-review-card',
      '# Card v2',
      state,
      'digest-B',
    );
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
    await materializeReviewCardArtifact(tmpDir, 'review-report-card', '# R', state, 'uuid-123');
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

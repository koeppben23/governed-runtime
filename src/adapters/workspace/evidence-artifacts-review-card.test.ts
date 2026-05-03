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
    tmpDir = path.join(
      os.tmpdir(),
      `flowguard-review-card-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

  it('writes .md and .json artifacts on first call', async () => {
    const result = await materializeReviewCardArtifact(
      tmpDir,
      'review-report-card',
      '# Report',
      state,
    );
    expect(result).toBeNull();

    const artifactsDir = path.join(tmpDir, 'artifacts');
    const md = await fs.readFile(path.join(artifactsDir, 'review-report-card.md'), 'utf-8');
    expect(md).toContain('# Report');

    const json = await fs.readFile(path.join(artifactsDir, 'review-report-card.json'), 'utf-8');
    const meta = JSON.parse(json);
    expect(meta.artifactType).toBe('review-report-card');
    expect(meta.derived).toBe(true);
    expect(meta.source).toBe('presentation');
    expect(meta.phase).toBe('REVIEW_COMPLETE');
    expect(meta.markdownSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(meta.stateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(meta.path).toBe('artifacts/review-report-card.md');
  });

  it('is idempotent — same content returns null (no-op)', async () => {
    await materializeReviewCardArtifact(tmpDir, 'review-report-card', '# Report', state);
    const result = await materializeReviewCardArtifact(
      tmpDir,
      'review-report-card',
      '# Report',
      state,
    );
    expect(result).toBeNull();
  });

  it('rejects different content (immutable artifact)', async () => {
    await materializeReviewCardArtifact(tmpDir, 'review-report-card', '# Report', state);
    const result = await materializeReviewCardArtifact(
      tmpDir,
      'review-report-card',
      '# Different',
      state,
    );
    expect(result).not.toBeNull();
    expect(result?.code).toBe('REVIEW_CARD_ARTIFACT_IMMUTABLE');

    // Original file content is preserved.
    const artifactsDir = path.join(tmpDir, 'artifacts');
    const md = await fs.readFile(path.join(artifactsDir, 'review-report-card.md'), 'utf-8');
    expect(md).toContain('# Report');
  });

  it('writes plan-review-card and architecture-review-card types', async () => {
    const r1 = await materializeReviewCardArtifact(
      tmpDir,
      'plan-review-card',
      '# Plan Card',
      state,
    );
    expect(r1).toBeNull();
    const r2 = await materializeReviewCardArtifact(
      tmpDir,
      'architecture-review-card',
      '# Arch Card',
      state,
    );
    expect(r2).toBeNull();

    const artifactsDir = path.join(tmpDir, 'artifacts');
    expect(await fs.readFile(path.join(artifactsDir, 'plan-review-card.md'), 'utf-8')).toContain(
      '# Plan Card',
    );
    expect(
      await fs.readFile(path.join(artifactsDir, 'architecture-review-card.md'), 'utf-8'),
    ).toContain('# Arch Card');
  });
});

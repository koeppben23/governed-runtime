import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendReviewerCapture,
  readReviewerCaptures,
  reviewerCapturePath,
} from './persistence-reviewer-capture.js';
import { acquireSessionWriteLock } from './persistence-lock.js';
import { PersistenceError } from './persistence.js';
import type { ReviewerSubagentCapture } from '../state/evidence-reviewer-capture.js';

const OBLIGATION_ID = '11111111-1111-4111-8111-111111111111';

function capture(overrides: Partial<ReviewerSubagentCapture> = {}): ReviewerSubagentCapture {
  return {
    capturedAt: '2026-01-01T00:00:00.000Z',
    source: 'post_tool_use_hook',
    sessionId: 'ses_parent',
    agentId: 'agent_001',
    agentType: 'flowguard-reviewer',
    toolName: 'mcp__flowguard__flowguard_review',
    reviewToolInvoked: true,
    obligationId: OBLIGATION_ID,
    ...overrides,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('reviewer capture persistence', () => {
  let sessDir: string;

  beforeEach(async () => {
    sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-capture-persist-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(sessDir, { recursive: true, force: true });
  });

  it('serializes append under the existing session write lock', async () => {
    const lock = await acquireSessionWriteLock(sessDir);
    const pending = appendReviewerCapture(sessDir, capture());

    await wait(150);
    await expect(fs.readFile(reviewerCapturePath(sessDir), 'utf-8')).rejects.toMatchObject({
      code: 'ENOENT',
    });

    await lock.release();
    await pending;

    const read = await readReviewerCaptures(sessDir);
    expect(read.skipped).toBe(0);
    expect(read.captures).toHaveLength(1);
    expect(read.captures[0]!.agentId).toBe('agent_001');
  });

  it('preserves all records during concurrent appends', async () => {
    const count = 25;
    await Promise.all(
      Array.from({ length: count }, (_unused, index) =>
        appendReviewerCapture(
          sessDir,
          capture({
            agentId: `agent_${String(index).padStart(3, '0')}`,
            obligationId: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
          }),
        ),
      ),
    );

    const read = await readReviewerCaptures(sessDir);
    const agentIds = new Set(read.captures.map((entry) => entry.agentId));
    expect(read.skipped).toBe(0);
    expect(read.captures).toHaveLength(count);
    expect(agentIds.size).toBe(count);
  });

  it('preserves malformed existing lines while appending the new capture', async () => {
    await fs.writeFile(reviewerCapturePath(sessDir), '{not-json}\n', 'utf-8');

    await appendReviewerCapture(sessDir, capture());

    const raw = await fs.readFile(reviewerCapturePath(sessDir), 'utf-8');
    expect(raw).toContain('{not-json}\n');
    expect(raw).toContain('"agentId":"agent_001"');

    const read = await readReviewerCaptures(sessDir);
    expect(read.skipped).toBe(1);
    expect(read.captures).toHaveLength(1);
  });

  it('throws WRITE_FAILED instead of reporting success when append cannot read the target', async () => {
    await fs.mkdir(reviewerCapturePath(sessDir));

    await expect(appendReviewerCapture(sessDir, capture())).rejects.toMatchObject({
      name: 'PersistenceError',
      code: 'WRITE_FAILED',
    } satisfies Partial<PersistenceError>);

    await expect(readReviewerCaptures(sessDir)).rejects.toMatchObject({ code: 'READ_FAILED' });
  });

  it('rejects invalid capture schema before writing', async () => {
    await expect(
      appendReviewerCapture(sessDir, { ...capture(), agentId: '' } as ReviewerSubagentCapture),
    ).rejects.toMatchObject({
      name: 'PersistenceError',
      code: 'SCHEMA_VALIDATION_FAILED',
    });

    await expect(fs.readFile(reviewerCapturePath(sessDir), 'utf-8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

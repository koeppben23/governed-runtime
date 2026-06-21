/**
 * @module integration/tools-execute.test
 * @description Execution tests for all 10 FlowGuard tool execute() functions.
 *
 * Tests split into individual files per tool/feature group:
 *   - tools-execute-status.test.ts    (status)
 *   - tools-execute-hydrate.test.ts   (hydrate, P27 Actor)
 *   - tools-execute-hydrate-p31.test.ts (P31 Config as Runtime Authority)
 *   - tools-execute-ticket.test.ts     (ticket)
 *   - tools-execute-planning.test.ts   (plan)
 *   - tools-execute-review.test.ts    (P34a review, policy, decision)
 *   - tools-execute-p26.test.ts       (P26 regulated archive)
 *   - tools-execute-implement.test.ts    (implement)
 *   - tools-execute-run-check.test.ts    (run_check / validation)
 *   - tools-execute-review-flow.test.ts  (review flow)
 *   - tools-execute-abort-session.test.ts (abort_session)
 *   - tools-execute-archive.test.ts   (archive, cross-cutting)
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SPLIT_FILES = [
  'tools-execute-status.test.ts',
  'tools-execute-hydrate.test.ts',
  'tools-execute-hydrate-p31.test.ts',
  'tools-execute-ticket.test.ts',
  'tools-execute-planning.test.ts',
  'tools-execute-review.test.ts',
  'tools-execute-p26.test.ts',
  'tools-execute-implement.test.ts',
  'tools-execute-run-check.test.ts',
  'tools-execute-review-flow.test.ts',
  'tools-execute-abort-session.test.ts',
  'tools-execute-archive.test.ts',
];

describe('tools-execute.test.ts — facade', () => {
  it('all split test files exist', () => {
    for (const f of SPLIT_FILES) {
      const exists = fs.existsSync(path.join(__dirname, f));
      expect(exists, `missing: ${f}`).toBe(true);
    }
  });
});

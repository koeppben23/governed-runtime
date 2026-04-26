/**
 * @module integration/tools-execute.test
 * @description Execution tests for all 10 FlowGuard tool execute() functions.
 *
 * Tests split into individual files per tool/feature group:
 *   - tools-execute-session.test.ts   (status, hydrate)
 *   - tools-execute-planning.test.ts  (ticket, plan)
 *   - tools-execute-review.test.ts    (P34a review, policy, decision)
 *   - tools-execute-p26.test.ts       (P26 regulated archive)
 *   - tools-execute-execution.test.ts (implement, validate, review, abort)
 *   - tools-execute-archive.test.ts   (archive, cross-cutting)
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SPLIT_FILES = [
  'tools-execute-session.test.ts',
  'tools-execute-planning.test.ts',
  'tools-execute-review.test.ts',
  'tools-execute-p26.test.ts',
  'tools-execute-execution.test.ts',
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

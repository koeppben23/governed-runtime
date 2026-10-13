/**
 * @module documentation/demo-aggregate-status.test
 * @description Wrapper exit-code aggregation: 0 = success, 2 = NOT_VERIFIED,
 * every other code (including 127/137) = FAILED, and FAILED outranks
 * NOT_VERIFIED regardless of order.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 * @version v1
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { aggregateStatus } from '../../../demos/lib/aggregate-status.mjs';

const CLI = join(process.cwd(), 'demos', 'lib', 'aggregate-status.mjs');

describe('demo aggregate status', () => {
  describe('HAPPY — success keeps the current status', () => {
    it('keeps 0 on success and preserves FAILED over later success', () => {
      expect(aggregateStatus(0, 0)).toBe(0);
      expect(aggregateStatus(1, 0)).toBe(1);
      expect(aggregateStatus(2, 0)).toBe(2);
    });
  });

  describe('BAD — unexpected exit codes are FAILED', () => {
    it('maps 127, 137 and negative signal codes to FAILED', () => {
      expect(aggregateStatus(0, 127)).toBe(1);
      expect(aggregateStatus(0, 137)).toBe(1);
      expect(aggregateStatus(0, -9)).toBe(1);
      expect(aggregateStatus(2, 127)).toBe(1);
    });
  });

  describe('CORNER — FAILED outranks NOT_VERIFIED in both orders', () => {
    it('never downgrades FAILED', () => {
      expect(aggregateStatus(1, 2)).toBe(1);
      expect(aggregateStatus(2, 1)).toBe(1);
    });
  });

  describe('EDGE — the CLI mapping matches the pure function', () => {
    it('is usable from the wrapper through the CLI', () => {
      for (const [current, code, expected] of [
        [0, 0, '0'],
        [0, 2, '2'],
        [0, 127, '1'],
        [1, 2, '1'],
      ] as const) {
        const result = spawnSync(process.execPath, [CLI, String(current), String(code)], {
          encoding: 'utf8',
        });
        expect(result.stdout).toBe(expected);
      }
    });
  });
});

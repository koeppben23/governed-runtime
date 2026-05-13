/**
 * @module any-elimination.test
 * @description Targeted regression tests for FG-REL-044: eliminate remaining any types.
 *
 * Only tests specific behavioral/structural invariants — no global source-metric counters.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC_DIR = path.resolve(import.meta.dirname, '.');

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(SRC_DIR, relativePath), 'utf-8');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Production typing
// ═══════════════════════════════════════════════════════════════════════════════

describe('plugin-logging.ts', () => {
  describe('HAPPY — any eliminated', () => {
    it('has no eslint-disable no-explicit-any', () => {
      const source = readSource('integration/plugin-logging.ts');
      expect(source).not.toContain('no-explicit-any');
    });

    it('defines PluginLogClient interface', () => {
      const source = readSource('integration/plugin-logging.ts');
      expect(source).toContain('interface PluginLogClient');
    });

    it('PluginLogMessage.level uses union, not string', () => {
      const source = readSource('integration/plugin-logging.ts');
      expect(source).toContain("level: 'debug' | 'info' | 'warn' | 'error'");
    });
  });

  describe('E2E — SDK client structural compatibility', () => {
    it('accepts client with matching log signature', async () => {
      const { buildLogSinks } = await import('./integration/plugin-logging.js');
      const config = {
        logging: { mode: 'both' as const, level: 'info', retentionDays: 7 },
      };
      const client = {
        app: {
          log: async (_msg: { body: { service: string; level: string; message: string } }) => {
            /* noop */
          },
        },
      };
      const sinks = buildLogSinks(config, client, '/tmp/test');
      expect(Array.isArray(sinks)).toBe(true);
    });
  });
});

describe('helpers.ts', () => {
  describe('HAPPY — single any justified', () => {
    it('execute(args: any) kept with Zod justification', () => {
      const source = readSource('integration/tools/helpers.ts');
      expect(source).toContain('execute(args: any');
      expect(source).toContain('no-explicit-any');
      expect(source).toContain('Zod');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// enforceBeforeVerdict narrow carrier type
// ═══════════════════════════════════════════════════════════════════════════════

describe('enforceBeforeVerdict signature', () => {
  describe('HAPPY — narrow carrier, not Partial<SessionState>', () => {
    it('uses selector-pattern parameter, not broad Partial', () => {
      const source = readSource('integration/review-enforcement.ts');
      expect(source).toContain("reviewAssurance?: SessionState['reviewAssurance']");
      expect(source).not.toContain('Partial<SessionState>');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// status.test.ts — no more (state.policySnapshot as any).selfReview mutation
// ═══════════════════════════════════════════════════════════════════════════════

describe('status.test.ts', () => {
  describe('HAPPY — no as any selfReview mutation', () => {
    it('mutates policySnapshot via typed spread, not as any', () => {
      const source = readSource('integration/status.test.ts');
      expect(source).not.toContain('as any).selfReview');
      expect(source).not.toContain('as any).policySnapshot');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Review enforcement tests — zero as any
// ═══════════════════════════════════════════════════════════════════════════════

describe('review-enforcement-session.test.ts', () => {
  describe('HAPPY — no as any', () => {
    it('has no as any casts', () => {
      const source = readSource('integration/review-enforcement-session.test.ts');
      expect(source).not.toContain('as any');
    });
  });
});

describe('review-enforcement-mutation.test.ts', () => {
  describe('HAPPY — no as any', () => {
    it('has no as any casts', () => {
      const source = readSource('integration/review-enforcement-mutation.test.ts');
      expect(source).not.toContain('as any');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BUG-21 tests — intentional as any casts are documented
// ═══════════════════════════════════════════════════════════════════════════════

describe('BUG-21 null-tolerance tests', () => {
  describe('EDGE — documented intentional casts', () => {
    it('planning BUG-21 block explains intentionally invalid input', () => {
      const source = readSource('integration/tools-execute-planning.test.ts');
      expect(source).toContain('BUG-21');
      expect(source).toContain('as any');
    });

    it('execution BUG-21 block explains intentionally invalid input', () => {
      const source = readSource('integration/tools-execute-execution.test.ts');
      expect(source).toContain('BUG-21');
      expect(source).toContain('as any');
    });

    it('architecture BUG-21 block explains intentionally invalid input', () => {
      const source = readSource('integration/tools/architecture-tool.test.ts');
      expect(source).toContain('BUG-21');
      expect(source).toContain('as any');
    });
  });
});

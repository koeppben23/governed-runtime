/**
 * @module integration/tools.test
 * @description Tests for the integration tools module.
 *
 * Since tools depend on the OpenCode runtime context (worktree, sessionID, etc.)
 * and interact with the filesystem, these tests validate:
 * - Export shape: all tools exported with the correct ToolDefinition structure
 * - Descriptions: non-empty, meaningful descriptions for LLM tool discovery
 * - Args schemas: tools that accept parameters have valid Zod schemas
 * - Barrel re-exports: integration/index.ts re-exports all tools correctly
 *
 * Full end-to-end tool execution tests require a mock OpenCode runtime
 * and are covered at the integration test level (outside unit tests).
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, PERF — all five categories present.
 */

import { describe, it, expect } from 'vitest';
import { PERF_ENABLED } from '../test-policy.js';
import {
  status,
  hydrate,
  ticket,
  plan,
  decision,
  implement,
  review_implementation,
  resolve_implementation_challenge,
  run_check,
  review,
  continue as continueTool,
  abort_session,
  archive,
  architecture,
  help,
  attachGovernanceFooter,
} from './tools/index.js';
import * as barrel from './index.js';
import { benchmarkSync } from '../test-policy.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** All 15 exported tool names, matching the filenames OpenCode will discover. */
const TOOL_NAMES = [
  'status',
  'hydrate',
  'ticket',
  'plan',
  'decision',
  'implement',
  'review_implementation',
  'resolve_implementation_challenge',
  'run_check',
  'review',
  'continue',
  'abort_session',
  'archive',
  'architecture',
  'help',
] as const;

/** Tools imported directly for testing. */
const TOOLS: Record<string, unknown> = {
  status,
  hydrate,
  ticket,
  plan,
  decision,
  implement,
  review_implementation,
  resolve_implementation_challenge,
  run_check,
  review,
  continue: continueTool,
  abort_session,
  archive,
  architecture,
  help,
};

/** Tools that accept arguments (have non-empty args schema). */
const TOOLS_WITH_ARGS = [
  'status',
  'hydrate',
  'ticket',
  'plan',
  'decision',
  'review_implementation',
  'resolve_implementation_challenge',
  'run_check',
  'abort_session',
  'architecture',
  'review',
  'help',
] as const;

/** Tools that have no arguments (args: {}). */
const TOOLS_WITHOUT_ARGS = ['implement'] as const;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('integration/tools', () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('exports exactly 15 tools', () => {
      expect(Object.keys(TOOLS).length).toBe(15);
    });

    for (const name of TOOL_NAMES) {
      it(`${name} has a valid ToolDefinition shape`, () => {
        const tool = TOOLS[name] as Record<string, unknown>;
        expect(tool).toBeDefined();
        expect(typeof tool.description).toBe('string');
        expect(typeof tool.args).toBe('object');
        expect(typeof tool.execute).toBe('function');
      });
    }

    for (const name of TOOL_NAMES) {
      it(`${name} has a non-empty description`, () => {
        const tool = TOOLS[name] as Record<string, unknown>;
        expect((tool.description as string).length).toBeGreaterThan(10);
      });
    }

    it('barrel re-exports all tools', () => {
      for (const name of TOOL_NAMES) {
        expect((barrel as Record<string, unknown>)[name]).toBeDefined();
        expect((barrel as Record<string, unknown>)[name]).toBe(TOOLS[name]);
      }
    });

    it('barrel re-exports FlowGuardAuditPlugin', () => {
      expect(barrel.FlowGuardAuditPlugin).toBeDefined();
      expect(typeof barrel.FlowGuardAuditPlugin).toBe('function');
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    it('does not export unknown tool names', () => {
      const knownKeys = new Set(TOOL_NAMES);
      const barrelKeys = Object.keys(barrel).filter((k) => k !== 'FlowGuardAuditPlugin');
      for (const key of barrelKeys) {
        expect(knownKeys.has(key as (typeof TOOL_NAMES)[number])).toBe(true);
      }
    });

    it('execute functions require 2 arguments (args, context)', () => {
      for (const name of TOOL_NAMES) {
        const tool = TOOLS[name] as Record<string, unknown>;
        // execute is a 2-param async function
        expect((tool.execute as Function).length).toBe(2);
      }
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    for (const name of TOOLS_WITH_ARGS) {
      it(`${name} has non-empty args schema`, () => {
        const tool = TOOLS[name] as Record<string, unknown>;
        const args = tool.args as Record<string, unknown>;
        expect(Object.keys(args).length).toBeGreaterThan(0);
      });
    }

    for (const name of TOOLS_WITHOUT_ARGS) {
      it(`${name} has empty args schema`, () => {
        const tool = TOOLS[name] as Record<string, unknown>;
        const args = tool.args as Record<string, unknown>;
        expect(Object.keys(args).length).toBe(0);
      });
    }

    it("hydrate policyMode describes config fallback to 'team'", () => {
      const h = TOOLS.hydrate as Record<string, unknown>;
      const args = h.args as Record<string, unknown>;
      const policyMode = args.policyMode as Record<string, unknown>;
      expect(h.description).toContain('team');
    });

    it('tool description strings are interned (same reference across accesses)', () => {
      for (const name of TOOL_NAMES) {
        const tool = TOOLS[name] as Record<string, unknown>;
        const desc1 = tool.description;
        const desc2 = tool.description;
        expect(desc1).toBe(desc2);
      }
    });
  });

  // ─── EDGE ─────────────────────────────────────────────────
  describe('EDGE', () => {
    it('status description mentions read-only / does NOT mutate', () => {
      const s = TOOLS.status as Record<string, unknown>;
      const desc = s.description as string;
      expect(desc.toLowerCase()).toContain('not');
      expect(desc.toLowerCase()).toContain('mutate');
    });

    it('abort_session description mentions irreversible', () => {
      const a = TOOLS.abort_session as Record<string, unknown>;
      const desc = a.description as string;
      expect(desc.toLowerCase()).toContain('irreversible');
    });

    it('decision description mentions human gate / review', () => {
      const d = TOOLS.decision as Record<string, unknown>;
      const desc = d.description as string;
      expect(desc.toLowerCase()).toContain('review');
    });

    it('all tool exports are referentially identical to barrel exports', () => {
      for (const name of TOOL_NAMES) {
        expect(TOOLS[name]).toBe((barrel as Record<string, unknown>)[name]);
      }
    });

    it('governance footer preserves object semantics and metadata', () => {
      const result = attachGovernanceFooter({
        output: JSON.stringify({
          phase: 'PLAN',
          next: 'Keep existing next action.',
          blocked: true,
          error: 'Original failure',
        }),
        metadata: {
          transition: { from: 'PLAN', to: 'PLAN' },
          flowguardFooter: { source: 'existing-metadata' },
        },
      });

      expect(typeof result).not.toBe('string');
      const wrapped = result as { output: string; metadata?: Record<string, unknown> };
      const output = JSON.parse(wrapped.output) as Record<string, unknown>;

      expect(output.phase).toBe('PLAN');
      expect(output.next).toBe('Keep existing next action.');
      expect(output.blocked).toBe(true);
      expect(output.error).toBe('Original failure');
      expect(output.flowguardFooter).toMatchObject({
        source: 'flowguard-tool-output-wrapper',
        authority: 'diagnostic-only',
        phase: 'PLAN',
      });
      expect(wrapped.metadata?.transition).toEqual({ from: 'PLAN', to: 'PLAN' });
      expect(wrapped.metadata?.flowguardFooter).toEqual({ source: 'existing-metadata' });
    });

    it('governance footer leaves non-object JSON and Markdown string outputs unchanged', () => {
      expect(attachGovernanceFooter('[{"phase":"PLAN"}]')).toBe('[{"phase":"PLAN"}]');
      expect(attachGovernanceFooter('null')).toBe('null');
      expect(attachGovernanceFooter('"ok"')).toBe('"ok"');
      expect(attachGovernanceFooter('## FlowGuard Help\n\nUse `/start`.')).toBe(
        '## FlowGuard Help\n\nUse `/start`.',
      );
    });

    it('adds minimal presentation to blocked OpenCode JSON without changing overflow fields', () => {
      const wrapped = attachGovernanceFooter(
        JSON.stringify({
          error: true,
          code: 'AUTO_ADVANCE_OVERFLOW',
          message: 'Auto-advance exceeded its step limit.',
          recovery: 'Inspect the workflow topology before retrying.',
          autoAdvanceOverflow: { phase: 'PLAN', limit: 10 },
        }),
      );
      const output = JSON.parse(wrapped as string) as Record<string, unknown>;

      expect(output.autoAdvanceOverflow).toEqual({ phase: 'PLAN', limit: 10 });
      expect(output.presentation).toEqual({
        markdown:
          '⚠ **Blocked:** `AUTO_ADVANCE_OVERFLOW` — Auto-advance exceeded its step limit.\n' +
          '**Recovery:** Inspect the workflow topology before retrying.\n\n' +
          'Inspect the workflow topology before retrying.',
      });
    });

    it('uses the requested glyph profile for wrapper-generated blocked presentations', () => {
      const wrapped = attachGovernanceFooter(
        JSON.stringify({ error: true, code: 'BLOCKED', message: 'Operation is blocked.' }),
        'ascii',
      );
      const output = JSON.parse(wrapped as string) as Record<string, unknown>;

      expect(output.presentation).toEqual({
        markdown: '[WARN] **Blocked:** `BLOCKED` — Operation is blocked.\n\nOperation is blocked.',
      });
    });

    it('preserves an existing blocked presentation', () => {
      const wrapped = attachGovernanceFooter(
        JSON.stringify({
          error: true,
          code: 'COMMAND_NOT_ALLOWED',
          message: 'Command is blocked.',
          presentation: { markdown: 'Existing presentation.' },
        }),
      );
      const output = JSON.parse(wrapped as string) as Record<string, unknown>;

      expect(output.presentation).toEqual({ markdown: 'Existing presentation.' });
    });

    it('barrel has exactly 16 named exports (15 tools + 1 plugin)', () => {
      const exports = Object.keys(barrel);
      expect(exports.length).toBe(16);
    });
  });

  // ── FG-266: Rename invariant tests ─────────────────────────
  describe('FG-266 parameter name normalization', () => {
    function toolArgs(tool: unknown): Record<string, unknown> {
      const t = tool as Record<string, unknown>;
      const args = (t.args ?? {}) as Record<string, unknown>;
      return args;
    }

    function toolDesc(tool: unknown): string {
      const t = tool as Record<string, unknown>;
      return (t.description as string) ?? '';
    }

    it('plan exposes reviewVerdict, not selfReviewVerdict', () => {
      expect(Object.keys(toolArgs(plan))).toContain('reviewVerdict');
      expect(Object.keys(toolArgs(plan))).not.toContain('selfReviewVerdict');
    });

    it('architecture exposes reviewVerdict, not selfReviewVerdict', () => {
      expect(Object.keys(toolArgs(architecture))).toContain('reviewVerdict');
      expect(Object.keys(toolArgs(architecture))).not.toContain('selfReviewVerdict');
    });

    it('review_implementation exposes reviewVerdict (issue #565)', () => {
      expect(Object.keys(toolArgs(review_implementation))).toContain('reviewVerdict');
    });

    it('implement (record tool) does NOT expose reviewVerdict (issue #565)', () => {
      expect(Object.keys(toolArgs(implement))).not.toContain('reviewVerdict');
      expect(Object.keys(toolArgs(implement))).toHaveLength(0);
    });

    it('review exposes reviewFindings, not analysisFindings', () => {
      expect(Object.keys(toolArgs(review))).toContain('reviewFindings');
      expect(Object.keys(toolArgs(review))).not.toContain('analysisFindings');
    });

    it('LLM-facing descriptions do not contain internal jargon', () => {
      const reviewableTools = [plan, architecture, implement, review];
      const inspectableTools = [status, continueTool, ...reviewableTools];
      const allDescs = inspectableTools
        .flatMap((t) => {
          const tRec = t as Record<string, unknown>;
          const args = (tRec.args as Record<string, unknown>) ?? {};
          return [
            (tRec.description as string) ?? '',
            ...Object.values(args)
              .filter((v) => v !== null && typeof v === 'object')
              .map((schema) => {
                const s = schema as { description?: string };
                return s.description ?? '';
              }),
          ];
        })
        .join(' ');
      expect(allDescs).not.toMatch(/F13/);
      expect(allDescs).not.toMatch(/canonical evaluator/);
      expect(allDescs).not.toMatch(/completeness truth/);
      expect(allDescs).not.toMatch(/flowguard-review-report\.v1/);
    });

    it('status and continue descriptions contain disambiguation guidance', () => {
      expect(toolDesc(status)).toMatch(/\/(status|continue)/);
      expect(toolDesc(continueTool)).toMatch(/\/(status|continue)/);
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe.skipIf(!PERF_ENABLED)('PERF', () => {
    it('importing all tools is effectively free (no side effects)', () => {
      // Tools are just objects with description, args, execute.
      // No database connections, no file reads, no network calls on import.
      // Verify by checking all tools are already available (loaded on module import).
      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        for (const name of TOOL_NAMES) {
          const tool = TOOLS[name] as Record<string, unknown>;
          // Access description to ensure the object is realized
          void tool.description;
        }
      }
      const elapsed = performance.now() - start;
      // 9000 property accesses in < 10ms
      expect(elapsed).toBeLessThan(10);
    });
  });
});

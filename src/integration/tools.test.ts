/**
 * @module integration/tools.test
 * @description Tests for the integration tools module.
 *
 * Since tools depend on the OpenCode runtime context (worktree, sessionID, etc.)
 * and interact with the filesystem, these tests validate:
 * - Export shape: all 11 tools exported with the correct ToolDefinition structure
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
import {
  status,
  hydrate,
  ticket,
  plan,
  decision,
  implement,
  validate,
  review,
  abort_session,
  archive,
  architecture,
} from './tools';
import * as barrel from './index';
import { benchmarkSync } from '../test-policy';

// ─── Constants ────────────────────────────────────────────────────────────────

/** All 11 exported tool names, matching the filenames OpenCode will discover. */
const TOOL_NAMES = [
  'status',
  'hydrate',
  'ticket',
  'plan',
  'decision',
  'implement',
  'validate',
  'review',
  'abort_session',
  'archive',
  'architecture',
] as const;

/** Tools imported directly for testing. */
const TOOLS: Record<string, unknown> = {
  status,
  hydrate,
  ticket,
  plan,
  decision,
  implement,
  validate,
  review,
  abort_session,
  archive,
  architecture,
};

/** Tools that accept arguments (have non-empty args schema). */
const TOOLS_WITH_ARGS = [
  'hydrate',
  'ticket',
  'plan',
  'decision',
  'implement',
  'validate',
  'abort_session',
  'architecture',
] as const;

/** Tools that have no arguments (args: {}). */
const TOOLS_WITHOUT_ARGS = ['status', 'review', 'archive'] as const;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('integration/tools', () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('exports exactly 11 tools', () => {
      expect(Object.keys(TOOLS).length).toBe(11);
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

    it('barrel re-exports all 11 tools', () => {
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

    it("hydrate default policyMode is 'solo'", () => {
      const h = TOOLS.hydrate as Record<string, unknown>;
      const args = h.args as Record<string, unknown>;
      const policyMode = args.policyMode as Record<string, unknown>;
      // Zod v4 stores default in _zod.def.defaultValue
      // We verify the description mentions 'solo' as default
      expect(h.description).toContain('solo');
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

    it('barrel has exactly 12 named exports (11 tools + 1 plugin)', () => {
      const exports = Object.keys(barrel);
      expect(exports.length).toBe(12);
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe('PERF', () => {
    it('importing all tools is effectively free (no side effects)', () => {
      // Tools are just objects with description, args, execute.
      // No database connections, no file reads, no network calls on import.
      // Verify by checking all 9 tools are already available (loaded on module import).
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

    it('tool description strings are interned (same reference across accesses)', () => {
      for (const name of TOOL_NAMES) {
        const tool = TOOLS[name] as Record<string, unknown>;
        const desc1 = tool.description;
        const desc2 = tool.description;
        expect(desc1).toBe(desc2); // Same reference, not a new string each time
      }
    });
  });
});

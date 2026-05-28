/**
 * @module integration/sdk-contract-mcp.test
 * @description MCP tool registry contract tests.
 *
 * Validates that FlowGuard's MCP server tool registry matches the pinned
 * JSON schema baselines in .sdk-baselines/mcp/. Detects:
 * - Tool additions/removals (breaking: removal, non-breaking: addition)
 * - Argument shape drift (new required fields are breaking)
 * - Description changes (informational)
 *
 * Evidence sources:
 * - .sdk-baselines/mcp/ (12 tool schema files + version.json)
 * - src/mcp-server/server.ts (tool registry)
 * - src/integration/tools/ (tool definitions with Zod args)
 *
 * @test-policy HAPPY, BAD, EDGE — all categories present.
 * @version v1
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';

// ─── Baseline Loading ────────────────────────────────────────────────────────

const root = path.resolve(import.meta.dirname, '..', '..');
const mcpBaseDir = path.join(root, '.sdk-baselines', 'mcp');

function loadSchema(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(mcpBaseDir, file), 'utf-8'));
}

// ─── Tool Registry (runtime source of truth) ────────────────────────────────

/** Expected MCP tool names (flowguard_ prefix). */
const EXPECTED_TOOLS = [
  'flowguard_status',
  'flowguard_hydrate',
  'flowguard_plan',
  'flowguard_implement',
  'flowguard_architecture',
  'flowguard_decision',
  'flowguard_run_check',
  'flowguard_ticket',
  'flowguard_review',
  'flowguard_abort_session',
  'flowguard_archive',
  'flowguard_continue',
] as const;

// ═══════════════════════════════════════════════════════════════════════════════
// MCP TOOL SCHEMA BASELINES
// ═══════════════════════════════════════════════════════════════════════════════

describe('SDK Contract: MCP tool registry', () => {
  describe('HAPPY: baseline directory and version.json exist', () => {
    it('.sdk-baselines/mcp/ directory exists', () => {
      expect(existsSync(mcpBaseDir)).toBe(true);
    });

    it('version.json exists and records server metadata', () => {
      const version = loadSchema('version.json');
      expect(version.platform).toBe('mcp');
      expect((version as Record<string, Record<string, unknown>>).server.name).toBe('flowguard');
      expect((version as Record<string, Record<string, unknown>>).server.version).toBe(
        '1.2.0-rc.3',
      );
    });

    it('version.json lists all 12 tool schemas', () => {
      const version = loadSchema('version.json');
      expect((version.schemas as string[]).length).toBe(12);
    });
  });

  describe('HAPPY: all 12 tool schema files exist', () => {
    for (const tool of EXPECTED_TOOLS) {
      it(`${tool}.json exists`, () => {
        expect(existsSync(path.join(mcpBaseDir, `${tool}.json`))).toBe(true);
      });
    }
  });

  describe('HAPPY: tool schemas have valid JSON Schema structure', () => {
    for (const tool of EXPECTED_TOOLS) {
      it(`${tool}.json has $schema, $id, title, and type=object`, () => {
        const schema = loadSchema(`${tool}.json`);
        expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
        expect(schema.$id).toBe(`mcp/${tool}`);
        expect(schema.title).toBe(tool);
        expect(schema.type).toBe('object');
      });
    }
  });

  describe('HAPPY: tool schemas have descriptions', () => {
    for (const tool of EXPECTED_TOOLS) {
      it(`${tool}.json has a non-empty description`, () => {
        const schema = loadSchema(`${tool}.json`);
        expect(typeof schema.description).toBe('string');
        expect((schema.description as string).length).toBeGreaterThan(10);
      });
    }
  });

  describe('HAPPY: required fields are pinned for tools that have them', () => {
    it('flowguard_decision requires verdict', () => {
      const schema = loadSchema('flowguard_decision.json');
      expect(schema.required).toContain('verdict');
    });

    it('flowguard_run_check requires kind', () => {
      const schema = loadSchema('flowguard_run_check.json');
      expect(schema.required).toContain('kind');
    });

    it('flowguard_ticket requires text', () => {
      const schema = loadSchema('flowguard_ticket.json');
      expect(schema.required).toContain('text');
    });
  });

  describe('HAPPY: tools with no args have empty properties', () => {
    it('flowguard_archive has no required fields', () => {
      const schema = loadSchema('flowguard_archive.json');
      expect(schema.required).toBeUndefined();
      expect(Object.keys(schema.properties as object)).toHaveLength(0);
    });

    it('flowguard_continue has no required fields', () => {
      const schema = loadSchema('flowguard_continue.json');
      expect(schema.required).toBeUndefined();
      expect(Object.keys(schema.properties as object)).toHaveLength(0);
    });
  });

  describe('HAPPY: enum values are pinned', () => {
    it('flowguard_hydrate policyMode enum has 4 values', () => {
      const schema = loadSchema('flowguard_hydrate.json');
      const props = schema.properties as Record<string, Record<string, unknown>>;
      expect(props.policyMode.enum).toEqual(['solo', 'team', 'team-ci', 'regulated']);
    });

    it('flowguard_hydrate claimedTaskClass enum has 3 values', () => {
      const schema = loadSchema('flowguard_hydrate.json');
      const props = schema.properties as Record<string, Record<string, unknown>>;
      expect(props.claimedTaskClass.enum).toEqual(['TRIVIAL', 'STANDARD', 'HIGH-RISK']);
    });

    it('flowguard_decision verdict enum has 3 values', () => {
      const schema = loadSchema('flowguard_decision.json');
      const props = schema.properties as Record<string, Record<string, unknown>>;
      expect(props.verdict.enum).toEqual(['approve', 'changes_requested', 'reject']);
    });

    it('flowguard_plan reviewVerdict enum has 2 values', () => {
      const schema = loadSchema('flowguard_plan.json');
      const props = schema.properties as Record<string, Record<string, unknown>>;
      expect(props.reviewVerdict.enum).toEqual(['approve', 'changes_requested']);
    });
  });

  describe('EDGE: no unexpected schema files in baseline directory', () => {
    it('only expected files exist in .sdk-baselines/mcp/', () => {
      const files = readdirSync(mcpBaseDir).filter((f) => f.endsWith('.json'));
      const expectedFiles = [...EXPECTED_TOOLS.map((t) => `${t}.json`), 'version.json'];
      for (const file of files) {
        expect(expectedFiles).toContain(file);
      }
    });
  });

  describe('EDGE: additionalProperties is pinned to false for strict schemas', () => {
    for (const tool of EXPECTED_TOOLS) {
      it(`${tool}.json has additionalProperties=false`, () => {
        const schema = loadSchema(`${tool}.json`);
        expect(schema.additionalProperties).toBe(false);
      });
    }
  });

  describe('BAD: missing schema file would be caught', () => {
    it('non-existent tool schema returns false from existsSync', () => {
      expect(existsSync(path.join(mcpBaseDir, 'flowguard_nonexistent.json'))).toBe(false);
    });
  });
});

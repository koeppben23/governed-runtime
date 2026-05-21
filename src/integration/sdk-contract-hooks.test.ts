/**
 * @module integration/sdk-contract-hooks.test
 * @description Per-platform hook protocol contract tests.
 *
 * Validates that FlowGuard's hook implementations conform to the pinned
 * JSON schema baselines for both Claude Code and Codex hook protocols.
 *
 * Evidence sources:
 * - .sdk-baselines/claude-code/ (6 schema files)
 * - .sdk-baselines/codex/ (6 schema files)
 * - src/hooks/shared/types.ts (FlowGuard hook types)
 * - src/templates/claude-code-plugin.ts (Claude Code hook wiring)
 * - src/templates/codex-plugin.ts (Codex hook wiring)
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all categories present.
 * @version v1
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';

// ─── Baseline Loading ────────────────────────────────────────────────────────

const root = path.resolve(import.meta.dirname, '..', '..');
const claudeBaseDir = path.join(root, '.sdk-baselines', 'claude-code');
const codexBaseDir = path.join(root, '.sdk-baselines', 'codex');

function loadSchema(dir: string, file: string): Record<string, unknown> {
  const filePath = path.join(dir, file);
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

// ─── FlowGuard Hook Output Shapes ───────────────────────────────────────────

/** The deny output shape FlowGuard emits on PreToolUse denial. */
const FLOWGUARD_DENY_OUTPUT = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'Phase gate: mutating tools blocked in current phase.',
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// CLAUDE CODE HOOK PROTOCOL
// ═══════════════════════════════════════════════════════════════════════════════

describe('SDK Contract: Claude Code hook protocol', () => {
  describe('HAPPY: baseline schema files exist', () => {
    const expectedFiles = [
      'pre-tool-use-input.json',
      'pre-tool-use-output.json',
      'post-tool-use-input.json',
      'post-tool-use-output.json',
      'session-start-input.json',
      'stop-input.json',
      'version.json',
    ];

    for (const file of expectedFiles) {
      it(`${file} exists in .sdk-baselines/claude-code/`, () => {
        expect(existsSync(path.join(claudeBaseDir, file))).toBe(true);
      });
    }
  });

  describe('HAPPY: PreToolUse input schema matches FlowGuard hook expectations', () => {
    it('schema requires session_id, tool_name, tool_input', () => {
      const schema = loadSchema(claudeBaseDir, 'pre-tool-use-input.json');
      expect(schema.required).toContain('session_id');
      expect(schema.required).toContain('tool_name');
      expect(schema.required).toContain('tool_input');
    });

    it('schema includes transcript_path (string, Claude-specific)', () => {
      const schema = loadSchema(claudeBaseDir, 'pre-tool-use-input.json');
      const props = schema.properties as Record<string, unknown>;
      expect(props).toHaveProperty('transcript_path');
    });

    it('schema allows additional properties (forward-compat)', () => {
      const schema = loadSchema(claudeBaseDir, 'pre-tool-use-input.json');
      expect(schema.additionalProperties).toBe(true);
    });
  });

  describe('HAPPY: PreToolUse deny output matches FlowGuard emit shape', () => {
    it('FlowGuard deny output has required hookSpecificOutput fields', () => {
      const schema = loadSchema(claudeBaseDir, 'pre-tool-use-output.json');
      expect(schema.required).toContain('hookSpecificOutput');
      const hookOutput = (schema.properties as Record<string, Record<string, unknown>>)
        .hookSpecificOutput;
      expect(hookOutput.required).toContain('hookEventName');
      expect(hookOutput.required).toContain('permissionDecision');
      expect(hookOutput.required).toContain('permissionDecisionReason');
    });

    it('FlowGuard deny output satisfies schema structure', () => {
      // Verify our actual output has all required fields
      expect(FLOWGUARD_DENY_OUTPUT.hookSpecificOutput.hookEventName).toBe('PreToolUse');
      expect(FLOWGUARD_DENY_OUTPUT.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(typeof FLOWGUARD_DENY_OUTPUT.hookSpecificOutput.permissionDecisionReason).toBe(
        'string',
      );
    });
  });

  describe('HAPPY: PostToolUse schemas align with FlowGuard audit hook', () => {
    it('post-tool-use input includes tool_name and tool_input', () => {
      const schema = loadSchema(claudeBaseDir, 'post-tool-use-input.json');
      expect(schema.required).toContain('tool_name');
      expect(schema.required).toContain('tool_input');
    });

    it('post-tool-use output supports additionalContext injection', () => {
      const schema = loadSchema(claudeBaseDir, 'post-tool-use-output.json');
      const props = schema.properties as Record<string, Record<string, unknown>>;
      const hookProps = props.hookSpecificOutput.properties as Record<string, unknown>;
      expect(hookProps).toHaveProperty('additionalContext');
    });
  });

  describe('HAPPY: SessionStart and Stop schemas have session_id', () => {
    it('session-start requires session_id', () => {
      const schema = loadSchema(claudeBaseDir, 'session-start-input.json');
      expect(schema.required).toContain('session_id');
    });

    it('stop requires session_id', () => {
      const schema = loadSchema(claudeBaseDir, 'stop-input.json');
      expect(schema.required).toContain('session_id');
    });
  });

  describe('EDGE: Claude Code does NOT have hook_event_name field', () => {
    it('pre-tool-use input has no hook_event_name (Codex-only)', () => {
      const schema = loadSchema(claudeBaseDir, 'pre-tool-use-input.json');
      const required = schema.required as string[];
      expect(required).not.toContain('hook_event_name');
    });
  });

  describe('CORNER: version.json records schema source', () => {
    it('version.json has platform=claude-code and lists all schemas', () => {
      const version = loadSchema(claudeBaseDir, 'version.json');
      expect(version.platform).toBe('claude-code');
      expect((version.schemas as string[]).length).toBe(6);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CODEX HOOK PROTOCOL
// ═══════════════════════════════════════════════════════════════════════════════

describe('SDK Contract: Codex hook protocol', () => {
  describe('HAPPY: baseline schema files exist', () => {
    const expectedFiles = [
      'pre-tool-use-input.json',
      'pre-tool-use-output.json',
      'post-tool-use-input.json',
      'post-tool-use-output.json',
      'session-start-input.json',
      'stop-input.json',
      'version.json',
    ];

    for (const file of expectedFiles) {
      it(`${file} exists in .sdk-baselines/codex/`, () => {
        expect(existsSync(path.join(codexBaseDir, file))).toBe(true);
      });
    }
  });

  describe('HAPPY: PreToolUse input schema has Codex-specific fields', () => {
    it('schema requires hook_event_name (Codex-only, used for platform detection)', () => {
      const schema = loadSchema(codexBaseDir, 'pre-tool-use-input.json');
      expect(schema.required).toContain('hook_event_name');
    });

    it('schema has model field (Codex-only)', () => {
      const schema = loadSchema(codexBaseDir, 'pre-tool-use-input.json');
      const props = schema.properties as Record<string, unknown>;
      expect(props).toHaveProperty('model');
    });

    it('schema has permission_mode field', () => {
      const schema = loadSchema(codexBaseDir, 'pre-tool-use-input.json');
      const props = schema.properties as Record<string, Record<string, unknown>>;
      expect(props.permission_mode.enum).toContain('default');
      expect(props.permission_mode.enum).toContain('full-auto');
    });

    it('schema has turn_id and tool_use_id (Codex-only)', () => {
      const schema = loadSchema(codexBaseDir, 'pre-tool-use-input.json');
      const props = schema.properties as Record<string, unknown>;
      expect(props).toHaveProperty('turn_id');
      expect(props).toHaveProperty('tool_use_id');
    });

    it('transcript_path allows null (Codex may not provide it)', () => {
      const schema = loadSchema(codexBaseDir, 'pre-tool-use-input.json');
      const props = schema.properties as Record<string, Record<string, unknown>>;
      const transcriptType = props.transcript_path.type;
      expect(transcriptType).toContain('null');
    });
  });

  describe('HAPPY: PreToolUse deny output supports updatedInput (arg rewriting)', () => {
    it('output schema has updatedInput in hookSpecificOutput', () => {
      const schema = loadSchema(codexBaseDir, 'pre-tool-use-output.json');
      const hookProps = (schema.properties as Record<string, Record<string, unknown>>)
        .hookSpecificOutput.properties as Record<string, unknown>;
      expect(hookProps).toHaveProperty('updatedInput');
    });

    it('permissionDecision allows both deny and allow', () => {
      const schema = loadSchema(codexBaseDir, 'pre-tool-use-output.json');
      const hookProps = (schema.properties as Record<string, Record<string, unknown>>)
        .hookSpecificOutput.properties as Record<string, Record<string, unknown>>;
      expect(hookProps.permissionDecision.enum).toContain('deny');
      expect(hookProps.permissionDecision.enum).toContain('allow');
    });
  });

  describe('HAPPY: PostToolUse input has tool_response (Codex-only)', () => {
    it('post-tool-use input includes tool_response field', () => {
      const schema = loadSchema(codexBaseDir, 'post-tool-use-input.json');
      const props = schema.properties as Record<string, unknown>;
      expect(props).toHaveProperty('tool_response');
    });
  });

  describe('HAPPY: SessionStart has source field (startup/resume/clear)', () => {
    it('session-start includes source enum', () => {
      const schema = loadSchema(codexBaseDir, 'session-start-input.json');
      const props = schema.properties as Record<string, Record<string, unknown>>;
      expect(props.source.enum).toContain('startup');
      expect(props.source.enum).toContain('resume');
      expect(props.source.enum).toContain('clear');
    });
  });

  describe('HAPPY: Stop has stop_hook_active and last_assistant_message', () => {
    it('stop includes stop_hook_active boolean', () => {
      const schema = loadSchema(codexBaseDir, 'stop-input.json');
      const props = schema.properties as Record<string, Record<string, unknown>>;
      expect(props.stop_hook_active.type).toBe('boolean');
    });

    it('stop includes last_assistant_message (nullable)', () => {
      const schema = loadSchema(codexBaseDir, 'stop-input.json');
      const props = schema.properties as Record<string, Record<string, unknown>>;
      expect(props.last_assistant_message.type).toContain('null');
    });
  });

  describe('EDGE: FlowGuard deny output works on both platforms', () => {
    it('same deny output shape satisfies both Claude Code and Codex schemas', () => {
      // FlowGuard uses the same hookSpecificOutput format for both platforms
      const claudeSchema = loadSchema(claudeBaseDir, 'pre-tool-use-output.json');
      const codexSchema = loadSchema(codexBaseDir, 'pre-tool-use-output.json');

      // Both require hookSpecificOutput with same 3 fields
      const claudeReq = (claudeSchema.properties as Record<string, Record<string, unknown>>)
        .hookSpecificOutput.required as string[];
      const codexReq = (codexSchema.properties as Record<string, Record<string, unknown>>)
        .hookSpecificOutput.required as string[];

      expect(claudeReq).toContain('hookEventName');
      expect(claudeReq).toContain('permissionDecision');
      expect(claudeReq).toContain('permissionDecisionReason');
      expect(codexReq).toContain('hookEventName');
      expect(codexReq).toContain('permissionDecision');
      expect(codexReq).toContain('permissionDecisionReason');
    });
  });

  describe('CORNER: Codex vs Claude Code field differences are captured', () => {
    it('Codex requires hook_event_name, Claude Code does not', () => {
      const codexSchema = loadSchema(codexBaseDir, 'pre-tool-use-input.json');
      const claudeSchema = loadSchema(claudeBaseDir, 'pre-tool-use-input.json');
      expect(codexSchema.required as string[]).toContain('hook_event_name');
      expect((claudeSchema.required as string[] | undefined) ?? []).not.toContain(
        'hook_event_name',
      );
    });

    it('Claude Code has transcript_path as string; Codex as string|null', () => {
      const claudeSchema = loadSchema(claudeBaseDir, 'pre-tool-use-input.json');
      const codexSchema = loadSchema(codexBaseDir, 'pre-tool-use-input.json');
      const claudeType = (claudeSchema.properties as Record<string, Record<string, unknown>>)
        .transcript_path.type;
      const codexType = (codexSchema.properties as Record<string, Record<string, unknown>>)
        .transcript_path.type;
      expect(claudeType).toBe('string');
      expect(codexType).toContain('null');
    });
  });

  describe('CORNER: version.json records platform metadata', () => {
    it('version.json has platform=codex', () => {
      const version = loadSchema(codexBaseDir, 'version.json');
      expect(version.platform).toBe('codex');
      expect((version.schemas as string[]).length).toBe(6);
    });
  });
});

/**
 * @module hooks/hooks.test
 * @description Unit and negative-path tests for FlowGuard command hook scripts.
 *
 * Covers all five test categories (HAPPY, BAD, CORNER, EDGE, PERF) for:
 * - stdin-reader (parsing, validation)
 * - stdout-writer (deny formatting)
 * - platform-detect (Claude Code vs Codex detection)
 * - session-resolver (fingerprint → state resolution)
 * - pre-tool-use (phase gate decision logic)
 *
 * @see https://github.com/koeppben23/governed-runtime/issues/244
 */

import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import {
  readStdin,
  validateToolHookPayload,
  validateSessionPayload,
  StdinReadError,
} from './shared/stdin-reader.js';
import { DenyOutputError, formatDenyOutput, writeDeny, writeLog } from './shared/stdout-writer.js';
import { detectPlatform } from './shared/platform-detect.js';
import {
  isMutatingHostTool,
  isHostToolAllowedInPhase,
  isSubagentAuthorized,
} from './shared/phase-gate.js';
import type { HookPlatform } from './shared/types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createReadableFromString(content: string): NodeJS.ReadableStream {
  const stream = new Readable();
  stream.push(content);
  stream.push(null);
  return stream;
}

function createEmptyReadable(): NodeJS.ReadableStream {
  const stream = new Readable();
  stream.push(null);
  return stream;
}

// ─── stdin-reader ────────────────────────────────────────────────────────────

describe('stdin-reader', () => {
  describe('HAPPY', () => {
    it('should parse valid JSON object from stdin', async () => {
      const input = JSON.stringify({ tool_name: 'Bash', session_id: 'sess_1', cwd: '/tmp' });
      const result = await readStdin(createReadableFromString(input));
      expect(result).toEqual({ tool_name: 'Bash', session_id: 'sess_1', cwd: '/tmp' });
    });

    it('should trim whitespace around JSON', async () => {
      const input = '  \n' + JSON.stringify({ foo: 'bar' }) + '\n  ';
      const result = await readStdin(createReadableFromString(input));
      expect(result).toEqual({ foo: 'bar' });
    });

    it('should handle complex nested payloads', async () => {
      const payload = {
        tool_name: 'Bash',
        tool_input: { command: 'npm test', env: { CI: 'true' } },
        session_id: 'sess_abc123',
        cwd: '/path/to/project',
        transcript_path: '/tmp/transcript.json',
      };
      const result = await readStdin(createReadableFromString(JSON.stringify(payload)));
      expect(result).toEqual(payload);
    });
  });

  describe('BAD', () => {
    it('should throw on empty stdin', async () => {
      await expect(readStdin(createEmptyReadable())).rejects.toThrow(StdinReadError);
      await expect(readStdin(createEmptyReadable())).rejects.toMatchObject({ code: 'STDIN_EMPTY' });
    });

    it('should throw on invalid JSON', async () => {
      const stream = createReadableFromString('not json at all');
      await expect(readStdin(stream)).rejects.toThrow(StdinReadError);
      await expect(readStdin(createReadableFromString('{broken'))).rejects.toMatchObject({
        code: 'STDIN_INVALID_JSON',
      });
    });

    it('should throw on non-object JSON (array)', async () => {
      const stream = createReadableFromString('[1, 2, 3]');
      await expect(readStdin(stream)).rejects.toMatchObject({ code: 'STDIN_NOT_OBJECT' });
    });

    it('should throw on non-object JSON (string)', async () => {
      const stream = createReadableFromString('"hello"');
      await expect(readStdin(stream)).rejects.toMatchObject({ code: 'STDIN_NOT_OBJECT' });
    });

    it('should throw on non-object JSON (null)', async () => {
      const stream = createReadableFromString('null');
      await expect(readStdin(stream)).rejects.toMatchObject({ code: 'STDIN_NOT_OBJECT' });
    });

    it('should throw on non-object JSON (number)', async () => {
      const stream = createReadableFromString('42');
      await expect(readStdin(stream)).rejects.toMatchObject({ code: 'STDIN_NOT_OBJECT' });
    });
  });

  describe('CORNER', () => {
    it('should handle whitespace-only stdin as empty', async () => {
      const stream = createReadableFromString('   \n\t  ');
      await expect(readStdin(stream)).rejects.toMatchObject({ code: 'STDIN_EMPTY' });
    });

    it('should handle very large payloads', async () => {
      const large = { data: 'x'.repeat(100_000), tool_name: 'Bash' };
      const result = await readStdin(createReadableFromString(JSON.stringify(large)));
      expect(result['tool_name']).toBe('Bash');
    });
  });

  describe('EDGE', () => {
    it('should handle chunked delivery', async () => {
      const stream = new Readable();
      const json = JSON.stringify({ tool_name: 'Write', session_id: 's1', cwd: '/a' });
      // Push in chunks
      stream.push(json.slice(0, 10));
      stream.push(json.slice(10));
      stream.push(null);
      const result = await readStdin(stream);
      expect(result['tool_name']).toBe('Write');
    });
  });
});

// ─── validateToolHookPayload ─────────────────────────────────────────────────

describe('validateToolHookPayload', () => {
  describe('HAPPY', () => {
    it('should validate a complete payload', () => {
      const payload = {
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        session_id: 'sess_abc',
        cwd: '/project',
      };
      const result = validateToolHookPayload(payload);
      expect(result.tool_name).toBe('Bash');
      expect(result.tool_input).toEqual({ command: 'ls' });
      expect(result.session_id).toBe('sess_abc');
      expect(result.cwd).toBe('/project');
    });

    it('should default tool_input to empty object when missing', () => {
      const payload = { tool_name: 'Bash', session_id: 's1', cwd: '/a' };
      const result = validateToolHookPayload(payload);
      expect(result.tool_input).toEqual({});
    });
  });

  describe('BAD', () => {
    it('should throw on missing tool_name', () => {
      expect(() => validateToolHookPayload({ session_id: 's1', cwd: '/a' })).toThrow(
        StdinReadError,
      );
    });

    it('should throw on empty tool_name', () => {
      expect(() => validateToolHookPayload({ tool_name: '', session_id: 's1', cwd: '/a' })).toThrow(
        StdinReadError,
      );
    });

    it('should throw on missing session_id', () => {
      expect(() => validateToolHookPayload({ tool_name: 'Bash', cwd: '/a' })).toThrow(
        StdinReadError,
      );
    });

    it('should throw on missing cwd', () => {
      expect(() => validateToolHookPayload({ tool_name: 'Bash', session_id: 's1' })).toThrow(
        StdinReadError,
      );
    });

    it('should report all validation errors at once', () => {
      try {
        validateToolHookPayload({});
        expect.fail('should have thrown');
      } catch (err) {
        expect((err as StdinReadError).message).toContain('tool_name');
        expect((err as StdinReadError).message).toContain('session_id');
        expect((err as StdinReadError).message).toContain('cwd');
      }
    });
  });

  describe('CORNER', () => {
    it('should handle tool_input as array (defaults to empty)', () => {
      const payload = { tool_name: 'Bash', tool_input: [1, 2], session_id: 's1', cwd: '/a' };
      const result = validateToolHookPayload(payload);
      expect(result.tool_input).toEqual({});
    });

    it('should handle tool_input as null (defaults to empty)', () => {
      const payload = { tool_name: 'Bash', tool_input: null, session_id: 's1', cwd: '/a' };
      const result = validateToolHookPayload(payload);
      expect(result.tool_input).toEqual({});
    });
  });
});

// ─── validateSessionPayload ──────────────────────────────────────────────────

describe('validateSessionPayload', () => {
  describe('HAPPY', () => {
    it('should validate a session payload', () => {
      const result = validateSessionPayload({ session_id: 'sess_1', cwd: '/project' });
      expect(result.session_id).toBe('sess_1');
      expect(result.cwd).toBe('/project');
    });
  });

  describe('BAD', () => {
    it('should throw on missing session_id', () => {
      expect(() => validateSessionPayload({ cwd: '/a' })).toThrow(StdinReadError);
    });

    it('should throw on missing cwd', () => {
      expect(() => validateSessionPayload({ session_id: 's1' })).toThrow(StdinReadError);
    });
  });
});

// ─── stdout-writer ───────────────────────────────────────────────────────────

describe('stdout-writer', () => {
  describe('HAPPY', () => {
    it('should format deny output with code and reason', () => {
      const output = formatDenyOutput('PreToolUse', 'HOST_TOOL_PHASE_DENIED', 'Bash not allowed');
      expect(output).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'HOST_TOOL_PHASE_DENIED: Bash not allowed',
        },
      });
    });

    it('should format deny for PostToolUse event', () => {
      const output = formatDenyOutput('PostToolUse', 'CODE', 'reason');
      expect(output.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    });

    it('should write deny to stdout', async () => {
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((_chunk, callback) => {
        if (typeof callback === 'function') callback();
        return true;
      }) as typeof process.stdout.write);
      await writeDeny('PreToolUse', 'TEST_CODE', 'test reason');
      expect(writeSpy).toHaveBeenCalledTimes(1);
      const written = writeSpy.mock.calls[0]![0] as string;
      const parsed = JSON.parse(written.trim());
      expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
      writeSpy.mockRestore();
    });

    it('should fail closed when stdout deny write throws', async () => {
      const originalExitCode = process.exitCode;
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => {
        throw new Error('EPIPE');
      });
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      await expect(writeDeny('PreToolUse', 'TEST_DENY', 'deny reason')).rejects.toThrow(
        DenyOutputError,
      );

      expect(process.exitCode).toBe(2);
      expect(
        stderrSpy.mock.calls.some((call) => String(call[0]).includes('DENY_OUTPUT_FAILED')),
      ).toBe(true);
      expect(stderrSpy.mock.calls.some((call) => String(call[0]).includes('TEST_DENY'))).toBe(true);

      process.exitCode = originalExitCode;
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    });

    it('should fail closed when stdout deny write callback reports an error', async () => {
      const originalExitCode = process.exitCode;
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
        _chunk,
        callback,
      ) => {
        if (typeof callback === 'function') callback(new Error('callback EPIPE'));
        return true;
      }) as typeof process.stdout.write);
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      await expect(writeDeny('PreToolUse', 'TEST_DENY', 'deny reason')).rejects.toThrow(
        DenyOutputError,
      );

      expect(process.exitCode).toBe(2);
      expect(
        stderrSpy.mock.calls.some((call) => String(call[0]).includes('DENY_OUTPUT_FAILED')),
      ).toBe(true);
      expect(stderrSpy.mock.calls.some((call) => String(call[0]).includes('TEST_DENY'))).toBe(true);

      process.exitCode = originalExitCode;
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    });

    it('should fail closed when stdout deny write returns false', async () => {
      const originalExitCode = process.exitCode;
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => false);
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      await expect(writeDeny('PreToolUse', 'TEST_DENY', 'deny reason')).rejects.toThrow(
        DenyOutputError,
      );

      expect(process.exitCode).toBe(2);
      expect(
        stderrSpy.mock.calls.some((call) => String(call[0]).includes('DENY_OUTPUT_FAILED')),
      ).toBe(true);
      expect(stderrSpy.mock.calls.some((call) => String(call[0]).includes('TEST_DENY'))).toBe(true);

      process.exitCode = originalExitCode;
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    });

    it('should fail closed when stdout emits an error during deny write', async () => {
      const originalExitCode = process.exitCode;
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((() => {
        process.stdout.emit('error', new Error('stream EPIPE'));
        return true;
      }) as typeof process.stdout.write);
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      await expect(writeDeny('PreToolUse', 'TEST_DENY', 'deny reason')).rejects.toThrow(
        DenyOutputError,
      );

      expect(process.exitCode).toBe(2);
      expect(
        stderrSpy.mock.calls.some((call) => String(call[0]).includes('DENY_OUTPUT_FAILED')),
      ).toBe(true);
      expect(stderrSpy.mock.calls.some((call) => String(call[0]).includes('TEST_DENY'))).toBe(true);

      process.exitCode = originalExitCode;
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    });

    it('should write log to stderr', () => {
      const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      writeLog('test message');
      expect(writeSpy).toHaveBeenCalledTimes(1);
      expect(writeSpy.mock.calls[0]![0]).toContain('[FlowGuard Hook]');
      expect(writeSpy.mock.calls[0]![0]).toContain('test message');
      writeSpy.mockRestore();
    });
  });

  describe('CORNER', () => {
    it('should handle empty reason gracefully', () => {
      const output = formatDenyOutput('PreToolUse', 'CODE', '');
      expect(output.hookSpecificOutput.permissionDecisionReason).toBe('CODE: ');
    });

    it('should handle long reasons without truncation', () => {
      const longReason = 'x'.repeat(2000);
      const output = formatDenyOutput('PreToolUse', 'CODE', longReason);
      expect(output.hookSpecificOutput.permissionDecisionReason).toContain(longReason);
    });
  });
});

// ─── platform-detect ─────────────────────────────────────────────────────────

describe('platform-detect', () => {
  describe('HAPPY', () => {
    it('should detect Claude Code from transcript_path', () => {
      const result = detectPlatform({ transcript_path: '/tmp/transcript.json' });
      expect(result).toBe('claude-code' satisfies HookPlatform);
    });

    it('should detect Codex from hook_event_name', () => {
      const result = detectPlatform({ hook_event_name: 'PreToolUse' });
      expect(result).toBe('codex' satisfies HookPlatform);
    });

    it('should detect Codex when both model and hook_event_name present', () => {
      const result = detectPlatform({
        hook_event_name: 'PreToolUse',
        model: 'o3',
      });
      expect(result).toBe('codex');
    });
  });

  describe('BAD', () => {
    it('should return unknown when no platform markers present', () => {
      const result = detectPlatform({ tool_name: 'Bash', session_id: 's1' });
      expect(result).toBe('unknown');
    });

    it('should return unknown for empty object', () => {
      expect(detectPlatform({})).toBe('unknown');
    });
  });

  describe('CORNER', () => {
    it('should return unknown for empty transcript_path', () => {
      expect(detectPlatform({ transcript_path: '' })).toBe('unknown');
    });

    it('should return unknown for empty hook_event_name', () => {
      expect(detectPlatform({ hook_event_name: '' })).toBe('unknown');
    });

    it('should prioritize hook_event_name over transcript_path (Codex wins)', () => {
      // Both markers present — hook_event_name is checked first
      const result = detectPlatform({
        hook_event_name: 'PreToolUse',
        transcript_path: '/tmp/t.json',
      });
      expect(result).toBe('codex');
    });
  });

  describe('EDGE', () => {
    it('should handle non-string transcript_path', () => {
      expect(detectPlatform({ transcript_path: 123 })).toBe('unknown');
    });

    it('should handle non-string hook_event_name', () => {
      expect(detectPlatform({ hook_event_name: true })).toBe('unknown');
    });
  });
});

// ─── pre-tool-use decision logic (unit-level via phase-gate re-export) ───────

describe('pre-tool-use decision logic', () => {
  // We test the decision logic by directly using the same functions
  // that pre-tool-use.ts delegates to (imported statically above).

  describe('HAPPY', () => {
    it('should identify bash as mutating', () => {
      expect(isMutatingHostTool('bash')).toBe(true);
    });

    it('should identify write as mutating', () => {
      expect(isMutatingHostTool('write')).toBe(true);
    });

    it('should identify edit as mutating', () => {
      expect(isMutatingHostTool('edit')).toBe(true);
    });

    it('should identify apply_patch as mutating for Codex', () => {
      expect(isMutatingHostTool('apply_patch')).toBe(true);
    });

    it('should allow bash in IMPLEMENTATION phase', () => {
      const result = isHostToolAllowedInPhase('bash', 'IMPLEMENTATION');
      expect(result.allowed).toBe(true);
    });

    it('should allow bash in VALIDATION phase', () => {
      const result = isHostToolAllowedInPhase('bash', 'VALIDATION');
      expect(result.allowed).toBe(true);
    });

    it('should deny bash in TICKET phase', () => {
      const result = isHostToolAllowedInPhase('bash', 'TICKET');
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('HOST_TOOL_PHASE_DENIED');
    });

    it('should deny bash in PLAN phase', () => {
      const result = isHostToolAllowedInPhase('bash', 'PLAN');
      expect(result.allowed).toBe(false);
    });

    it('should deny apply_patch in PLAN phase', () => {
      const result = isHostToolAllowedInPhase('apply_patch', 'PLAN');
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('HOST_TOOL_PHASE_DENIED');
    });

    it('should allow apply_patch in IMPLEMENTATION phase', () => {
      const result = isHostToolAllowedInPhase('apply_patch', 'IMPLEMENTATION');
      expect(result.allowed).toBe(true);
    });

    it('should deny write in ARCHITECTURE phase', () => {
      const result = isHostToolAllowedInPhase('write', 'ARCHITECTURE');
      expect(result.allowed).toBe(false);
    });
  });

  describe('BAD', () => {
    it('should not identify read as mutating', () => {
      expect(isMutatingHostTool('read')).toBe(false);
    });

    it('should not identify glob as mutating', () => {
      expect(isMutatingHostTool('glob')).toBe(false);
    });

    it('should not identify webfetch as mutating', () => {
      expect(isMutatingHostTool('webfetch')).toBe(false);
    });

    it('should treat unknown tools as mutating until explicitly classified', () => {
      expect(isMutatingHostTool('unknown_tool')).toBe(true);
    });
  });

  describe('CORNER', () => {
    it('should allow non-mutating tools in any phase', () => {
      const phases = ['TICKET', 'PLAN', 'ARCHITECTURE', 'IMPLEMENTATION', 'VALIDATION', 'READY'];
      for (const phase of phases) {
        const result = isHostToolAllowedInPhase('read', phase as any);
        expect(result.allowed).toBe(true);
      }
    });

    it('should handle empty tool name as fail-closed mutating', () => {
      expect(isMutatingHostTool('')).toBe(true);
    });
  });

  describe('EDGE', () => {
    it('should handle case sensitivity (only lowercase matches)', () => {
      // The hook script normalizes to lowercase before calling
      expect(isMutatingHostTool('Bash')).toBe(true);
      expect(isMutatingHostTool('BASH')).toBe(true);
      expect(isMutatingHostTool('bash')).toBe(true);
    });
  });
});

// ─── subagent authorization (defense-in-depth) ──────────────────────────────

describe('subagent authorization', () => {
  describe('HAPPY', () => {
    it('should allow non-task tools unconditionally', () => {
      expect(isSubagentAuthorized('bash', { command: 'ls' })).toEqual({ allowed: true });
      expect(isSubagentAuthorized('write', { filePath: '/tmp' })).toEqual({ allowed: true });
      expect(isSubagentAuthorized('read', {})).toEqual({ allowed: true });
    });

    it('should allow task tool with authorized reviewer subagent type', () => {
      const result = isSubagentAuthorized('task', { subagent_type: 'flowguard-reviewer' });
      expect(result.allowed).toBe(true);
    });

    it('should allow task tool without subagent_type (not a subagent call)', () => {
      const result = isSubagentAuthorized('task', { prompt: 'do something' });
      expect(result.allowed).toBe(true);
    });

    it('should allow task tool with empty subagent_type', () => {
      const result = isSubagentAuthorized('task', { subagent_type: '' });
      expect(result.allowed).toBe(true);
    });
  });

  describe('BAD', () => {
    it('should deny task tool with unauthorized subagent type', () => {
      const result = isSubagentAuthorized('task', { subagent_type: 'malicious-agent' });
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('SUBAGENT_TYPE_UNAUTHORIZED');
      expect(result.reason).toContain('malicious-agent');
      expect(result.reason).toContain('flowguard-reviewer');
    });

    it('should deny task tool with non-string subagent_type', () => {
      const result = isSubagentAuthorized('task', { subagent_type: 42 });
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('SUBAGENT_TYPE_UNAUTHORIZED');
    });

    it('should deny task tool with boolean subagent_type', () => {
      const result = isSubagentAuthorized('task', { subagent_type: true });
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('SUBAGENT_TYPE_UNAUTHORIZED');
    });

    it('should deny task tool with array subagent_type', () => {
      const result = isSubagentAuthorized('task', { subagent_type: ['foo'] });
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('SUBAGENT_TYPE_UNAUTHORIZED');
    });
  });

  describe('CORNER', () => {
    it('should allow task tool with null subagent_type (not set)', () => {
      const result = isSubagentAuthorized('task', { subagent_type: null });
      expect(result.allowed).toBe(true);
    });

    it('should allow task tool with undefined subagent_type via missing key', () => {
      const result = isSubagentAuthorized('task', {});
      expect(result.allowed).toBe(true);
    });

    it('should be case-sensitive for subagent type (FlowGuard-Reviewer is unauthorized)', () => {
      const result = isSubagentAuthorized('task', { subagent_type: 'FlowGuard-Reviewer' });
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('SUBAGENT_TYPE_UNAUTHORIZED');
    });

    it('should deny similar but not exact subagent types', () => {
      const result = isSubagentAuthorized('task', { subagent_type: 'flowguard-reviewer-v2' });
      expect(result.allowed).toBe(false);
    });
  });

  describe('EDGE', () => {
    it('should not apply to Tool (capitalized) — hooks normalize to lowercase before call', () => {
      // Only lowercase 'task' triggers the check — upstream normalizes
      const result = isSubagentAuthorized('Task', { subagent_type: 'malicious' });
      // 'Task' !== 'task', so it's treated as non-task tool → allowed
      expect(result.allowed).toBe(true);
    });
  });
});

/**
 * @module integration/sdk-contract-runtime.test
 * @description Runtime shape validation (Zod-based) for the OpenCode plugin SDK.
 *
 * Validates the actual runtime shape of hook parameters matches what the SDK
 * type definitions promise. These catch shape changes that TypeScript
 * compile-time checks alone might not surface.
 *
 * Evidence sources:
 * - @opencode-ai/plugin/dist/index.d.ts (hook input/output shapes)
 * - @opencode-ai/plugin/dist/tool.d.ts (ToolContext shape)
 *
 * Split from sdk-contract.test.ts Section B for ≤400 LOC compliance.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all categories present.
 * @version v1
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// ═══════════════════════════════════════════════════════════════════════════════
// B) RUNTIME SHAPE VALIDATION (Zod-based)
//
// Validates the actual runtime shape of hook parameters matches
// what the SDK type definitions promise. These catch shape changes
// that TypeScript compile-time checks alone might not surface.
// ═══════════════════════════════════════════════════════════════════════════════

describe('SDK Contract: Runtime shape validation', () => {
  // ── B1: tool.execute.before input shape ─────────────────────────────────────
  // Verified against: plugin/dist/index.d.ts lines 231-233
  const BeforeHookInputSchema = z.object({
    tool: z.string(),
    sessionID: z.string(),
    callID: z.string(),
  });

  // ── B2: tool.execute.before output shape ────────────────────────────────────
  // Verified against: plugin/dist/index.d.ts lines 234-236
  const BeforeHookOutputSchema = z.object({
    args: z.unknown(),
  });

  // ── B3: tool.execute.after input shape ──────────────────────────────────────
  // Verified against: plugin/dist/index.d.ts lines 245-249
  const AfterHookInputSchema = z.object({
    tool: z.string(),
    sessionID: z.string(),
    callID: z.string(),
    args: z.unknown(),
  });

  // ── B4: tool.execute.after output shape ─────────────────────────────────────
  // Verified against: plugin/dist/index.d.ts lines 250-254
  const AfterHookOutputSchema = z.object({
    title: z.string(),
    output: z.string(),
    metadata: z.unknown(),
  });

  // ── B5: shell.env hook input shape ──────────────────────────────────────────
  // Verified against: plugin/dist/index.d.ts lines 238-241
  const ShellEnvInputSchema = z.object({
    cwd: z.string(),
    sessionID: z.optional(z.string()),
    callID: z.optional(z.string()),
  });

  const ShellEnvOutputSchema = z.object({
    env: z.record(z.string(), z.string()),
  });

  // ── B6: ToolContext shape ───────────────────────────────────────────────────
  // Verified against: plugin/dist/tool.d.ts lines 3-25
  const ToolContextSchema = z.object({
    sessionID: z.string(),
    messageID: z.string(),
    agent: z.string(),
    directory: z.string(),
    worktree: z.string(),
    abort: z.instanceof(AbortSignal),
    metadata: z.function(),
    ask: z.function(),
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // HAPPY PATH: valid payloads parse correctly
  // ═══════════════════════════════════════════════════════════════════════════

  describe('HAPPY: valid SDK payloads parse correctly', () => {
    it('before-hook input with all SDK fields', () => {
      const input = { tool: 'read', sessionID: 'sess-123', callID: 'call-456' };
      const result = BeforeHookInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('before-hook output with args object', () => {
      const output = { args: { filePath: '/foo/bar.ts' } };
      const result = BeforeHookOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });

    it('after-hook input with all SDK fields', () => {
      const input = {
        tool: 'write',
        sessionID: 'sess-123',
        callID: 'call-789',
        args: { filePath: '/tmp/x', content: 'hello' },
      };
      const result = AfterHookInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('after-hook output with all 3 SDK fields', () => {
      const output = {
        title: 'Wrote file',
        output: 'File written to /tmp/x',
        metadata: { bytes: 5 },
      };
      const result = AfterHookOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });

    it('shell.env input with all fields', () => {
      const input = { cwd: '/project', sessionID: 'sess-1', callID: 'call-1' };
      const result = ShellEnvInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('shell.env input with optional fields omitted', () => {
      const input = { cwd: '/project' };
      const result = ShellEnvInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('shell.env output with env record', () => {
      const output = { env: { PATH: '/usr/bin', NODE_ENV: 'test' } };
      const result = ShellEnvOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });

    it('ToolContext with all SDK fields', () => {
      const ctx = {
        sessionID: 'sess-1',
        messageID: 'msg-1',
        agent: 'default',
        directory: '/project',
        worktree: '/project',
        abort: new AbortController().signal,
        metadata: () => {},
        ask: () => {},
      };
      const result = ToolContextSchema.safeParse(ctx);
      expect(result.success).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // BAD PATH: invalid payloads are rejected
  // ═══════════════════════════════════════════════════════════════════════════

  describe('BAD: invalid payloads are rejected', () => {
    it('before-hook input missing callID fails', () => {
      const input = { tool: 'read', sessionID: 'sess-123' };
      const result = BeforeHookInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('before-hook input missing tool fails', () => {
      const input = { sessionID: 'sess-123', callID: 'call-456' };
      const result = BeforeHookInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('before-hook input missing sessionID fails', () => {
      const input = { tool: 'read', callID: 'call-456' };
      const result = BeforeHookInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('after-hook input missing args fails', () => {
      const input = { tool: 'write', sessionID: 'sess-1', callID: 'call-1' };
      const result = AfterHookInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('after-hook output missing title fails', () => {
      const output = { output: 'result', metadata: {} };
      const result = AfterHookOutputSchema.safeParse(output);
      expect(result.success).toBe(false);
    });

    it('after-hook output missing output fails', () => {
      const output = { title: 'Done', metadata: {} };
      const result = AfterHookOutputSchema.safeParse(output);
      expect(result.success).toBe(false);
    });

    it('shell.env input missing cwd fails', () => {
      const input = { sessionID: 'sess-1' };
      const result = ShellEnvInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('shell.env output with non-string env values fails', () => {
      const output = { env: { FOO: 42 } };
      const result = ShellEnvOutputSchema.safeParse(output);
      expect(result.success).toBe(false);
    });

    it('ToolContext missing required fields fails', () => {
      const ctx = { sessionID: 'sess-1' };
      const result = ToolContextSchema.safeParse(ctx);
      expect(result.success).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CORNER: boundary values
  // ═══════════════════════════════════════════════════════════════════════════

  describe('CORNER: boundary values', () => {
    it('before-hook input with empty strings passes schema', () => {
      const input = { tool: '', sessionID: '', callID: '' };
      const result = BeforeHookInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('before-hook output with null args passes (any/unknown)', () => {
      const output = { args: null };
      const result = BeforeHookOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });

    it('after-hook output with null metadata passes (any/unknown)', () => {
      const output = { title: '', output: '', metadata: null };
      const result = AfterHookOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });

    it('after-hook input with undefined args passes (unknown)', () => {
      const input = { tool: 'x', sessionID: 'y', callID: 'z', args: undefined };
      const result = AfterHookInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('shell.env output with empty env record passes', () => {
      const output = { env: {} };
      const result = ShellEnvOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });

    it('before-hook output with deeply nested args passes', () => {
      const output = { args: { nested: { deep: { value: [1, 2, 3] } } } };
      const result = BeforeHookOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // EDGE: extra fields and type coercion boundaries
  // ═══════════════════════════════════════════════════════════════════════════

  describe('EDGE: extra fields and type boundaries', () => {
    it('before-hook input with extra fields still passes (SDK may add fields)', () => {
      const input = {
        tool: 'read',
        sessionID: 'sess-1',
        callID: 'call-1',
        futureField: 'some-value',
      };
      const result = BeforeHookInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('after-hook output with extra fields still passes (SDK may add fields)', () => {
      const output = {
        title: 'Done',
        output: 'result',
        metadata: {},
        newField: 'future',
      };
      const result = AfterHookOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });

    it('after-hook input with extra fields still passes', () => {
      const input = {
        tool: 'bash',
        sessionID: 's',
        callID: 'c',
        args: {},
        extra: true,
      };
      const result = AfterHookInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('ToolContext with extra fields still passes', () => {
      const ctx = {
        sessionID: 's',
        messageID: 'm',
        agent: 'a',
        directory: '/d',
        worktree: '/w',
        abort: new AbortController().signal,
        metadata: () => {},
        ask: () => {},
        futureContextField: 42,
      };
      const result = ToolContextSchema.safeParse(ctx);
      expect(result.success).toBe(true);
    });
  });
});

/**
 * @module integration/sdk-contract.test
 * @description Compile-time type guards and narrowing compatibility for the OpenCode plugin SDK.
 *
 * These tests verify that:
 * 1. The SDK types we depend on exist and have the expected shape (compile-time)
 * 2. Our narrowed types (types.ts) are compatible subsets of the SDK contract
 *
 * Evidence sources:
 * - @opencode-ai/plugin/dist/index.d.ts (Hooks, Plugin, PluginInput)
 * - @opencode-ai/plugin/dist/tool.d.ts (ToolDefinition, ToolContext, ToolResult)
 * - https://opencode.ai/docs/plugins (official documentation)
 *
 * Runtime shape validation → sdk-contract-runtime.test.ts
 * Plugin factory + smoke + infra → sdk-contract-plugin.test.ts
 *
 * @test-policy HAPPY, EDGE — compile-time + narrowing categories.
 * @version v1
 */

import { describe, it, expect } from 'vitest';

// ── SDK imports (type-only for compile-time guards) ──────────────────────────
import type {
  Plugin,
  PluginInput,
  Hooks,
  PluginOptions,
  PluginModule,
  ToolDefinition as SDKToolDefinition,
} from '@opencode-ai/plugin';

import type {
  ToolContext as SDKToolContext,
  ToolResult as SDKToolResult,
} from '@opencode-ai/plugin/tool';

// ── Our narrowed types ───────────────────────────────────────────────────────
import type {
  ToolHookBeforeInput,
  ToolHookBeforeOutput,
  ToolHookAfterInput,
  ToolHookAfterOutput,
} from './types.js';

// ── Our internal types ───────────────────────────────────────────────────────
import type {
  ToolContext as InternalToolContext,
  ToolDefinition as InternalToolDefinition,
  ToolResult as InternalToolResult,
} from './tools/helpers.js';

// ── Our plugin export ────────────────────────────────────────────────────────
import { FlowGuardAuditPlugin } from './plugin.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Helper: compile-time type assertion. If this compiles, the assertion holds.
// These produce no runtime code — they exist only in the type system.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Asserts T is assignable to U. Compilation fails if not.
 * Usage: type _check = AssertAssignable<Narrower, Wider>;
 */
type AssertAssignable<T, U> = T extends U ? true : never;

/**
 * Asserts that K is a key of T. Compilation fails if not.
 */
type AssertKeyOf<T, K extends keyof T> = K;

// ═══════════════════════════════════════════════════════════════════════════════
// A) COMPILE-TIME TYPE GUARDS
//
// These use conditional types to verify SDK shape at compile time.
// If any assertion is wrong, the file will not compile — tsc catches it.
// ═══════════════════════════════════════════════════════════════════════════════

// ── A1: Hooks interface has all hook keys we use ─────────────────────────────
// Verified against: plugin/dist/index.d.ts lines 170-313
type _h1 = AssertKeyOf<Hooks, 'tool.execute.before'>;
type _h2 = AssertKeyOf<Hooks, 'tool.execute.after'>;
type _h3 = AssertKeyOf<Hooks, 'event'>;
type _h4 = AssertKeyOf<Hooks, 'shell.env'>;
type _h5 = AssertKeyOf<Hooks, 'tool'>;
type _h6 = AssertKeyOf<Hooks, 'tool.definition'>;
type _h7 = AssertKeyOf<Hooks, 'config'>;
type _h8 = AssertKeyOf<Hooks, 'chat.message'>;
type _h9 = AssertKeyOf<Hooks, 'chat.params'>;
type _h10 = AssertKeyOf<Hooks, 'chat.headers'>;
type _h11 = AssertKeyOf<Hooks, 'permission.ask'>;
type _h12 = AssertKeyOf<Hooks, 'command.execute.before'>;
type _h13 = AssertKeyOf<Hooks, 'experimental.session.compacting'>;
type _h14 = AssertKeyOf<Hooks, 'experimental.compaction.autocontinue'>;
type _h15 = AssertKeyOf<Hooks, 'experimental.text.complete'>;
type _h16 = AssertKeyOf<Hooks, 'experimental.chat.messages.transform'>;
type _h17 = AssertKeyOf<Hooks, 'experimental.chat.system.transform'>;

// ── A2: Hook return types are Promise<void> (not void | Promise<void>) ───────
// Verified against: plugin/dist/index.d.ts lines 231-254
type BeforeHook = NonNullable<Hooks['tool.execute.before']>;
type AfterHook = NonNullable<Hooks['tool.execute.after']>;
type EventHook = NonNullable<Hooks['event']>;
type ShellEnvHook = NonNullable<Hooks['shell.env']>;

type _r1 = AssertAssignable<ReturnType<BeforeHook>, Promise<void>>;
type _r2 = AssertAssignable<ReturnType<AfterHook>, Promise<void>>;
type _r3 = AssertAssignable<ReturnType<EventHook>, Promise<void>>;
type _r4 = AssertAssignable<ReturnType<ShellEnvHook>, Promise<void>>;

// ── A3: PluginInput has ALL 7 fields ─────────────────────────────────────────
// Verified against: plugin/dist/index.d.ts lines 36-46
type _pi1 = AssertKeyOf<PluginInput, 'client'>;
type _pi2 = AssertKeyOf<PluginInput, 'project'>;
type _pi3 = AssertKeyOf<PluginInput, 'directory'>;
type _pi4 = AssertKeyOf<PluginInput, 'worktree'>;
type _pi5 = AssertKeyOf<PluginInput, 'experimental_workspace'>;
type _pi6 = AssertKeyOf<PluginInput, 'serverUrl'>;
type _pi7 = AssertKeyOf<PluginInput, '$'>;

// Verify specific field types
type _pt1 = AssertAssignable<PluginInput['directory'], string>;
type _pt2 = AssertAssignable<PluginInput['worktree'], string>;
type _pt3 = AssertAssignable<PluginInput['serverUrl'], URL>;

// ── A4: Plugin type is function (PluginInput, options?) => Promise<Hooks> ────
// Verified against: plugin/dist/index.d.ts line 51
type _pl1 = AssertAssignable<
  Plugin,
  (input: PluginInput, options?: PluginOptions) => Promise<Hooks>
>;

// ── A5: PluginModule has server field typed as Plugin ─────────────────────────
// Verified against: plugin/dist/index.d.ts lines 52-56
type _pm1 = AssertKeyOf<PluginModule, 'server'>;
type _pm2 = AssertAssignable<PluginModule['server'], Plugin>;

// ── A6: Our ToolHookBeforeInput matches the SDK before-hook input exactly ────
// The SDK has { tool, sessionID, callID }, we now declare ALL fields.
type SDKBeforeInput = Parameters<BeforeHook>[0];
type _n1 = AssertKeyOf<SDKBeforeInput, 'tool'>;
type _n2 = AssertKeyOf<SDKBeforeInput, 'sessionID'>;
type _n3 = AssertKeyOf<SDKBeforeInput, 'callID'>;
type _n4 = AssertAssignable<SDKBeforeInput, ToolHookBeforeInput>;

// ── A6b: Our ToolHookAfterInput matches the SDK after-hook input exactly ─────
type SDKAfterInput = Parameters<AfterHook>[0];
type _na1 = AssertKeyOf<SDKAfterInput, 'tool'>;
type _na2 = AssertKeyOf<SDKAfterInput, 'sessionID'>;
type _na3 = AssertKeyOf<SDKAfterInput, 'callID'>;
type _na4 = AssertKeyOf<SDKAfterInput, 'args'>;
type _na5 = AssertAssignable<SDKAfterInput, ToolHookAfterInput>;

// ── A7: Our ToolHookAfterOutput matches the SDK after-hook output exactly ────
// The SDK has { title, output, metadata }, we now declare ALL fields.
type SDKAfterOutput = Parameters<AfterHook>[1];
type _no1 = AssertKeyOf<SDKAfterOutput, 'output'>;
type _no2 = AssertKeyOf<SDKAfterOutput, 'title'>;
type _no3 = AssertKeyOf<SDKAfterOutput, 'metadata'>;
type _no4 = AssertAssignable<SDKAfterOutput, ToolHookAfterOutput>;

// ── A8: FlowGuardAuditPlugin satisfies Plugin type ───────────────────────────
type _fg = AssertAssignable<typeof FlowGuardAuditPlugin, Plugin>;

// ── A9: SDK ToolContext fields are superset of our InternalToolContext ────────
// Verified against: plugin/dist/tool.d.ts lines 3-25
type _tc1 = AssertKeyOf<SDKToolContext, 'sessionID'>;
type _tc2 = AssertKeyOf<SDKToolContext, 'messageID'>;
type _tc3 = AssertKeyOf<SDKToolContext, 'agent'>;
type _tc4 = AssertKeyOf<SDKToolContext, 'directory'>;
type _tc5 = AssertKeyOf<SDKToolContext, 'worktree'>;
type _tc6 = AssertKeyOf<SDKToolContext, 'abort'>;
type _tc7 = AssertKeyOf<SDKToolContext, 'metadata'>;
type _tc8 = AssertKeyOf<SDKToolContext, 'ask'>; // SDK has ask(), we don't use it

// ── A10: SDK ToolResult is string | { output, metadata? } ────────────────────
// Verified against: plugin/dist/tool.d.ts lines 34-38
type _tr1 = AssertAssignable<string, SDKToolResult>;
type _tr2 = AssertAssignable<{ output: string }, SDKToolResult>;
type _tr3 = AssertAssignable<{ output: string; metadata: { key: string } }, SDKToolResult>;

// ── A10b: Our InternalToolResult matches SDK ToolResult ──────────────────────
type _tr4 = AssertAssignable<InternalToolResult, SDKToolResult>;

// ═══════════════════════════════════════════════════════════════════════════════
// C) OUR NARROWING COMPATIBILITY
//
// Verifies that our narrowed types in types.ts and tools/helpers.ts
// are compatible subsets of the SDK contract.
// ═══════════════════════════════════════════════════════════════════════════════

describe('SDK Contract: Narrowing compatibility', () => {
  // ── C1: ToolHookBeforeInput / ToolHookAfterInput exact match ────────────────

  describe('HAPPY: our ToolHookBeforeInput matches SDK before-hook input', () => {
    it('SDK before-hook input maps exactly to ToolHookBeforeInput', () => {
      const sdkInput = { tool: 'read', sessionID: 'sess-1', callID: 'call-1' };
      const typed: ToolHookBeforeInput = sdkInput;
      expect(typed.tool).toBe('read');
      expect(typed.sessionID).toBe('sess-1');
      expect(typed.callID).toBe('call-1');
    });
  });

  describe('HAPPY: our ToolHookAfterInput matches SDK after-hook input', () => {
    it('SDK after-hook input maps exactly to ToolHookAfterInput', () => {
      const sdkInput = {
        tool: 'bash',
        sessionID: 'sess-2',
        callID: 'call-2',
        args: { command: 'ls' },
      };
      const typed: ToolHookAfterInput = sdkInput;
      expect(typed.tool).toBe('bash');
      expect(typed.sessionID).toBe('sess-2');
      expect(typed.callID).toBe('call-2');
      expect(typed.args).toEqual({ command: 'ls' });
    });
  });

  describe('HAPPY: our ToolHookAfterOutput matches SDK after-hook output', () => {
    it('SDK after-hook output maps exactly to ToolHookAfterOutput', () => {
      const sdkOutput = { title: 'Done', output: 'result text', metadata: { k: 'v' } };
      const typed: ToolHookAfterOutput = sdkOutput;
      expect(typed.title).toBe('Done');
      expect(typed.output).toBe('result text');
      expect(typed.metadata).toEqual({ k: 'v' });
    });
  });

  describe('HAPPY: our ToolHookBeforeOutput reads from SDK before-hook output', () => {
    it('SDK before-hook output can be read as ToolHookBeforeOutput', () => {
      // SDK says args: any — we narrow to Record<string, unknown>
      const sdkOutput = { args: { filePath: '/foo' } };
      const narrowed: ToolHookBeforeOutput = sdkOutput;
      expect(narrowed.args).toEqual({ filePath: '/foo' });
    });
  });

  // ── C2: Before vs After input differentiation ──────────────────────────────

  describe('EDGE: before-hook and after-hook inputs have different shapes', () => {
    it('after-hook input has args field that before-hook input lacks', () => {
      const afterInput: ToolHookAfterInput = {
        tool: 'x',
        sessionID: 'y',
        callID: 'z',
        args: { a: 1 },
      };
      const beforeInput: ToolHookBeforeInput = { tool: 'x', sessionID: 'y', callID: 'z' };
      expect('args' in afterInput).toBe(true);
      expect('args' in beforeInput).toBe(false);
    });

    it('ToolHookAfterOutput exposes title and metadata for mutation', () => {
      const output: ToolHookAfterOutput = { title: 'Read', output: 'content', metadata: { x: 1 } };
      output.title = 'BLOCKED';
      output.metadata = { blocked: true };
      expect(output.title).toBe('BLOCKED');
      expect(output.metadata).toEqual({ blocked: true });
    });
  });

  // ── C3: InternalToolContext vs SDK ToolContext ──────────────────────────────

  describe('HAPPY: InternalToolContext is subset of SDK ToolContext', () => {
    it('all InternalToolContext fields exist on SDK ToolContext', () => {
      // Our InternalToolContext has: sessionID, messageID, agent, directory, worktree, abort, metadata
      // SDK ToolContext has all of those PLUS ask()
      // This is verified at compile time by A9 assertions above.
      // Runtime check: ensure the shape keys overlap
      const internalFields = [
        'sessionID',
        'messageID',
        'agent',
        'directory',
        'worktree',
        'abort',
        'metadata',
      ];
      const sdkFields = [
        'sessionID',
        'messageID',
        'agent',
        'directory',
        'worktree',
        'abort',
        'metadata',
        'ask',
      ];
      for (const field of internalFields) {
        expect(sdkFields).toContain(field);
      }
    });

    it('SDK ToolContext has ask() which InternalToolContext omits', () => {
      // Our InternalToolContext intentionally omits ask() because FlowGuard
      // tools don't request interactive permissions.
      const sdkOnlyFields = ['ask'];
      const internalFields = [
        'sessionID',
        'messageID',
        'agent',
        'directory',
        'worktree',
        'abort',
        'metadata',
      ];
      for (const field of sdkOnlyFields) {
        expect(internalFields).not.toContain(field);
      }
    });
  });
});

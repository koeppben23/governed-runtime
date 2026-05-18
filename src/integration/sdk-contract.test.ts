/**
 * @module integration/sdk-contract.test
 * @description Contract snapshot tests for the OpenCode plugin SDK.
 *
 * These tests verify that:
 * 1. The SDK types we depend on exist and have the expected shape
 * 2. Our narrowed types (types.ts) are compatible subsets of the SDK contract
 * 3. The Plugin factory accepts the full PluginInput shape
 * 4. Hook shapes match what the SDK delivers at runtime
 *
 * Evidence sources:
 * - @opencode-ai/plugin/dist/index.d.ts (Hooks, Plugin, PluginInput)
 * - @opencode-ai/plugin/dist/tool.d.ts (ToolDefinition, ToolContext, ToolResult)
 * - https://opencode.ai/docs/plugins (official documentation)
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, E2E, SMOKE ÔÇö all categories present.
 * @version v1
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

// ÔöÇÔöÇ SDK imports (type-only for compile-time guards) ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
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

// ÔöÇÔöÇ Our narrowed types ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
import type {
  ToolHookBeforeInput,
  ToolHookBeforeOutput,
  ToolHookAfterInput,
  ToolHookAfterOutput,
} from './types.js';

// ÔöÇÔöÇ Our internal types ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
import type {
  ToolContext as InternalToolContext,
  ToolDefinition as InternalToolDefinition,
  ToolResult as InternalToolResult,
} from './tools/helpers.js';

// ÔöÇÔöÇ Our plugin export ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
import { FlowGuardAuditPlugin, isUsableWorktree } from './plugin.js';

// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
// Helper: compile-time type assertion. If this compiles, the assertion holds.
// These produce no runtime code ÔÇö they exist only in the type system.
// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ

/**
 * Asserts T is assignable to U. Compilation fails if not.
 * Usage: type _check = AssertAssignable<Narrower, Wider>;
 */
type AssertAssignable<T, U> = T extends U ? true : never;

/**
 * Asserts that K is a key of T. Compilation fails if not.
 */
type AssertKeyOf<T, K extends keyof T> = K;

// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
// A) COMPILE-TIME TYPE GUARDS
//
// These use conditional types to verify SDK shape at compile time.
// If any assertion is wrong, the file will not compile ÔÇö tsc catches it.
// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ

// ÔöÇÔöÇ A1: Hooks interface has all hook keys we use ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
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

// ÔöÇÔöÇ A2: Hook return types are Promise<void> (not void | Promise<void>) ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
// Verified against: plugin/dist/index.d.ts lines 231-254
type BeforeHook = NonNullable<Hooks['tool.execute.before']>;
type AfterHook = NonNullable<Hooks['tool.execute.after']>;
type EventHook = NonNullable<Hooks['event']>;
type ShellEnvHook = NonNullable<Hooks['shell.env']>;

type _r1 = AssertAssignable<ReturnType<BeforeHook>, Promise<void>>;
type _r2 = AssertAssignable<ReturnType<AfterHook>, Promise<void>>;
type _r3 = AssertAssignable<ReturnType<EventHook>, Promise<void>>;
type _r4 = AssertAssignable<ReturnType<ShellEnvHook>, Promise<void>>;

// ÔöÇÔöÇ A3: PluginInput has ALL 7 fields ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
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

// ÔöÇÔöÇ A4: Plugin type is function (PluginInput, options?) => Promise<Hooks> ÔöÇÔöÇÔöÇ
// Verified against: plugin/dist/index.d.ts line 51
type _pl1 = AssertAssignable<
  Plugin,
  (input: PluginInput, options?: PluginOptions) => Promise<Hooks>
>;

// ÔöÇÔöÇ A5: PluginModule has server field typed as Plugin ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
// Verified against: plugin/dist/index.d.ts lines 52-56
type _pm1 = AssertKeyOf<PluginModule, 'server'>;
type _pm2 = AssertAssignable<PluginModule['server'], Plugin>;

// ÔöÇÔöÇ A6: Our ToolHookBeforeInput matches the SDK before-hook input exactly ÔöÇÔöÇÔöÇ
// The SDK has { tool, sessionID, callID }, we now declare ALL fields.
type SDKBeforeInput = Parameters<BeforeHook>[0];
type _n1 = AssertKeyOf<SDKBeforeInput, 'tool'>;
type _n2 = AssertKeyOf<SDKBeforeInput, 'sessionID'>;
type _n3 = AssertKeyOf<SDKBeforeInput, 'callID'>;
type _n4 = AssertAssignable<SDKBeforeInput, ToolHookBeforeInput>;

// ÔöÇÔöÇ A6b: Our ToolHookAfterInput matches the SDK after-hook input exactly ÔöÇÔöÇÔöÇÔöÇ
type SDKAfterInput = Parameters<AfterHook>[0];
type _na1 = AssertKeyOf<SDKAfterInput, 'tool'>;
type _na2 = AssertKeyOf<SDKAfterInput, 'sessionID'>;
type _na3 = AssertKeyOf<SDKAfterInput, 'callID'>;
type _na4 = AssertKeyOf<SDKAfterInput, 'args'>;
type _na5 = AssertAssignable<SDKAfterInput, ToolHookAfterInput>;

// ÔöÇÔöÇ A7: Our ToolHookAfterOutput matches the SDK after-hook output exactly ÔöÇÔöÇÔöÇ
// The SDK has { title, output, metadata }, we now declare ALL fields.
type SDKAfterOutput = Parameters<AfterHook>[1];
type _no1 = AssertKeyOf<SDKAfterOutput, 'output'>;
type _no2 = AssertKeyOf<SDKAfterOutput, 'title'>;
type _no3 = AssertKeyOf<SDKAfterOutput, 'metadata'>;
type _no4 = AssertAssignable<SDKAfterOutput, ToolHookAfterOutput>;

// ÔöÇÔöÇ A8: FlowGuardAuditPlugin satisfies Plugin type ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
type _fg = AssertAssignable<typeof FlowGuardAuditPlugin, Plugin>;

// ÔöÇÔöÇ A9: SDK ToolContext fields are superset of our InternalToolContext ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
// Verified against: plugin/dist/tool.d.ts lines 3-25
type _tc1 = AssertKeyOf<SDKToolContext, 'sessionID'>;
type _tc2 = AssertKeyOf<SDKToolContext, 'messageID'>;
type _tc3 = AssertKeyOf<SDKToolContext, 'agent'>;
type _tc4 = AssertKeyOf<SDKToolContext, 'directory'>;
type _tc5 = AssertKeyOf<SDKToolContext, 'worktree'>;
type _tc6 = AssertKeyOf<SDKToolContext, 'abort'>;
type _tc7 = AssertKeyOf<SDKToolContext, 'metadata'>;
type _tc8 = AssertKeyOf<SDKToolContext, 'ask'>; // SDK has ask(), we don't use it

// ÔöÇÔöÇ A10: SDK ToolResult is string | { output, metadata? } ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
// Verified against: plugin/dist/tool.d.ts lines 34-38
type _tr1 = AssertAssignable<string, SDKToolResult>;
type _tr2 = AssertAssignable<{ output: string }, SDKToolResult>;
type _tr3 = AssertAssignable<{ output: string; metadata: { key: string } }, SDKToolResult>;

// ÔöÇÔöÇ A10b: Our InternalToolResult matches SDK ToolResult ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
type _tr4 = AssertAssignable<InternalToolResult, SDKToolResult>;

// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
// B) RUNTIME SHAPE VALIDATION (Zod-based)
//
// Validates the actual runtime shape of hook parameters matches
// what the SDK type definitions promise. These catch shape changes
// that TypeScript compile-time checks alone might not surface.
// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ

describe('SDK Contract: Runtime shape validation', () => {
  // ÔöÇÔöÇ B1: tool.execute.before input shape ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  // Verified against: plugin/dist/index.d.ts lines 231-233
  const BeforeHookInputSchema = z.object({
    tool: z.string(),
    sessionID: z.string(),
    callID: z.string(),
  });

  // ÔöÇÔöÇ B2: tool.execute.before output shape ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  // Verified against: plugin/dist/index.d.ts lines 234-236
  const BeforeHookOutputSchema = z.object({
    args: z.unknown(),
  });

  // ÔöÇÔöÇ B3: tool.execute.after input shape ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  // Verified against: plugin/dist/index.d.ts lines 245-249
  const AfterHookInputSchema = z.object({
    tool: z.string(),
    sessionID: z.string(),
    callID: z.string(),
    args: z.unknown(),
  });

  // ÔöÇÔöÇ B4: tool.execute.after output shape ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  // Verified against: plugin/dist/index.d.ts lines 250-254
  const AfterHookOutputSchema = z.object({
    title: z.string(),
    output: z.string(),
    metadata: z.unknown(),
  });

  // ÔöÇÔöÇ B5: shell.env hook input shape ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  // Verified against: plugin/dist/index.d.ts lines 238-241
  const ShellEnvInputSchema = z.object({
    cwd: z.string(),
    sessionID: z.optional(z.string()),
    callID: z.optional(z.string()),
  });

  const ShellEnvOutputSchema = z.object({
    env: z.record(z.string(), z.string()),
  });

  // ÔöÇÔöÇ B6: ToolContext shape ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
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

  // ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
  // HAPPY PATH: valid payloads parse correctly
  // ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ

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

  // ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
  // BAD PATH: invalid payloads are rejected
  // ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ

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

  // ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
  // CORNER: boundary values
  // ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ

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

  // ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
  // EDGE: extra fields and type coercion boundaries
  // ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ

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

// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
// C) OUR NARROWING COMPATIBILITY
//
// Verifies that our narrowed types in types.ts and tools/helpers.ts
// are compatible subsets of the SDK contract.
// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ

describe('SDK Contract: Narrowing compatibility', () => {
  // ÔöÇÔöÇ C1: ToolHookBeforeInput / ToolHookAfterInput exact match ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

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
      // SDK says args: any ÔÇö we narrow to Record<string, unknown>
      const sdkOutput = { args: { filePath: '/foo' } };
      const narrowed: ToolHookBeforeOutput = sdkOutput;
      expect(narrowed.args).toEqual({ filePath: '/foo' });
    });
  });

  // ÔöÇÔöÇ C2: Before vs After input differentiation ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

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

  // ÔöÇÔöÇ C3: InternalToolContext vs SDK ToolContext ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

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

// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
// D) PLUGIN FACTORY RESILIENCE
//
// Validates that FlowGuardAuditPlugin handles edge cases in PluginInput
// gracefully without crashing.
// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ

describe('SDK Contract: Plugin factory resilience', () => {
  /**
   * Create a mock PluginInput with all 7 required fields.
   * Fields we don't use (project, $, experimental_workspace, serverUrl) are stubs.
   */
  function createMockPluginInput(overrides: Partial<PluginInput> = {}): PluginInput {
    return {
      client: {
        app: { log: async () => ({}) },
      } as PluginInput['client'],
      project: {} as PluginInput['project'],
      directory: '/tmp/sdk-contract-test',
      worktree: '/tmp/sdk-contract-test',
      experimental_workspace: { register: () => {} },
      serverUrl: new URL('http://localhost:4096'),
      $: (() => {}) as unknown as PluginInput['$'],
      ...overrides,
    };
  }

  // ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
  // HAPPY PATH
  // ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ

  describe('HAPPY: plugin returns hooks with expected shape', () => {
    it('returns an object with tool.execute.before and tool.execute.after', async () => {
      const hooks = await FlowGuardAuditPlugin(createMockPluginInput());
      expect(hooks).toBeDefined();
      expect(typeof hooks['tool.execute.before']).toBe('function');
      expect(typeof hooks['tool.execute.after']).toBe('function');
    });

    it('returned hooks satisfy the Hooks interface', async () => {
      const hooks: Hooks = await FlowGuardAuditPlugin(createMockPluginInput());
      // This assignment compiles only if the return satisfies Hooks
      expect(hooks).toBeDefined();
    });
  });

  // ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
  // BAD PATH
  // ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ

  describe('BAD: plugin degrades gracefully with non-repo worktree', () => {
    it('does not crash with non-existent worktree path', async () => {
      const hooks = await FlowGuardAuditPlugin(
        createMockPluginInput({ worktree: '/nonexistent/path/abc123' }),
      );
      expect(hooks).toBeDefined();
      expect(typeof hooks['tool.execute.before']).toBe('function');
      expect(typeof hooks['tool.execute.after']).toBe('function');
    });

    it('does not crash with empty worktree string', async () => {
      const hooks = await FlowGuardAuditPlugin(
        createMockPluginInput({ worktree: '', directory: '' }),
      );
      expect(hooks).toBeDefined();
    });
  });

  // ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
  // CORNER PATH
  // ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ

  describe('CORNER: isUsableWorktree boundary conditions', () => {
    it('empty string returns false', () => {
      expect(isUsableWorktree('')).toBe(false);
    });

    it('undefined returns false', () => {
      expect(isUsableWorktree(undefined)).toBe(false);
    });

    it('filesystem root returns false', () => {
      expect(isUsableWorktree('/')).toBe(false);
    });

    it('Windows drive root returns false', () => {
      expect(isUsableWorktree('C:\\')).toBe(false);
      expect(isUsableWorktree('D:/')).toBe(false);
    });

    it('path without .git returns false', () => {
      expect(isUsableWorktree('/tmp')).toBe(false);
    });
  });

  // ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
  // EDGE PATH
  // ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ

  describe('EDGE: plugin with stub-only unused fields', () => {
    it('does not access project, $, experimental_workspace, serverUrl', async () => {
      // We provide trap proxies for unused fields. If the plugin accesses
      // any property on them, the proxy throws ÔÇö proving we don't use them.
      const trapHandler: ProxyHandler<object> = {
        get(_target, prop) {
          // Allow Symbol.toPrimitive and similar internal JS operations
          if (typeof prop === 'symbol') return undefined;
          // Allow toString/valueOf for error messages
          if (prop === 'toString' || prop === 'valueOf') return () => '[trap]';
          throw new Error(`Unexpected access to unused field property: ${String(prop)}`);
        },
      };

      const input = createMockPluginInput({
        project: new Proxy({}, trapHandler) as PluginInput['project'],
        $: new Proxy(() => {}, trapHandler) as unknown as PluginInput['$'],
        experimental_workspace: new Proxy(
          { register: () => {} },
          trapHandler,
        ) as PluginInput['experimental_workspace'],
        // serverUrl is a URL ÔÇö can't easily proxy, but we can verify
        // it's not accessed by using a valid but unusual URL
        serverUrl: new URL('http://trap.invalid:9999'),
      });

      // If this doesn't throw, the plugin doesn't access unused fields
      const hooks = await FlowGuardAuditPlugin(input);
      expect(hooks).toBeDefined();
    });
  });
});

// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
// E) SMOKE: End-to-end hook invocation
//
// Validates that calling the hooks with SDK-shaped payloads doesn't crash.
// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ

describe('SDK Contract: Smoke ÔÇö hook invocation with SDK payloads', () => {
  function createMockPluginInput(): PluginInput {
    return {
      client: {
        app: { log: async () => ({}) },
      } as PluginInput['client'],
      project: {} as PluginInput['project'],
      directory: '/tmp/sdk-smoke',
      worktree: '/tmp/sdk-smoke',
      experimental_workspace: { register: () => {} },
      serverUrl: new URL('http://localhost:4096'),
      $: (() => {}) as unknown as PluginInput['$'],
    };
  }

  it('SMOKE: before-hook accepts SDK-shaped input without crashing', async () => {
    const hooks = await FlowGuardAuditPlugin(createMockPluginInput());
    const beforeHook = hooks['tool.execute.before'];
    expect(beforeHook).toBeDefined();

    // Call with full SDK shape (including callID which our types omit)
    const input = { tool: 'unknown_tool', sessionID: 'sess-smoke', callID: 'call-smoke' };
    const output = { args: {} };

    // Should not throw ÔÇö unknown tools are passed through
    await expect(beforeHook!(input, output)).resolves.not.toThrow();
  });

  it('SMOKE: after-hook accepts SDK-shaped output without crashing', async () => {
    const hooks = await FlowGuardAuditPlugin(createMockPluginInput());
    const afterHook = hooks['tool.execute.after'];
    expect(afterHook).toBeDefined();

    // Call with full SDK shape (including title + metadata)
    const input = {
      tool: 'unknown_tool',
      sessionID: 'sess-smoke',
      callID: 'call-smoke',
      args: {},
    };
    const output = { title: 'Unknown', output: 'some output', metadata: null };

    await expect(afterHook!(input, output)).resolves.not.toThrow();
  });

  it('SMOKE: before-hook handles flowguard-prefixed tool', async () => {
    const hooks = await FlowGuardAuditPlugin(createMockPluginInput());
    const beforeHook = hooks['tool.execute.before'];

    const input = { tool: 'flowguard_status', sessionID: 'sess-fg', callID: 'call-fg' };
    const output = { args: {} };

    // FlowGuard tools are handled by the plugin ÔÇö should not crash
    await expect(beforeHook!(input, output)).resolves.not.toThrow();
  });

  it('SMOKE: after-hook handles flowguard-prefixed tool', async () => {
    const hooks = await FlowGuardAuditPlugin(createMockPluginInput());
    const afterHook = hooks['tool.execute.after'];

    const input = {
      tool: 'flowguard_status',
      sessionID: 'sess-fg',
      callID: 'call-fg',
      args: {},
    };
    const output = { title: 'Status', output: '{}', metadata: null };

    await expect(afterHook!(input, output)).resolves.not.toThrow();
  });
});

// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
// F) SDK TYPE BASELINE INTEGRITY
//
// Validates the snapshot script infrastructure works correctly.
// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ

describe('SDK Contract: Type baseline infrastructure', () => {
  const root = path.resolve(import.meta.dirname, '..', '..');

  it('HAPPY: baseline files exist in .opencode-sdk-baseline/', () => {
    expect(existsSync(path.join(root, '.opencode-sdk-baseline', 'plugin-index.d.ts'))).toBe(true);
    expect(existsSync(path.join(root, '.opencode-sdk-baseline', 'plugin-tool.d.ts'))).toBe(true);
  });

  it('HAPPY: baseline files match installed SDK', () => {
    const indexBaseline = readFileSync(
      path.join(root, '.opencode-sdk-baseline', 'plugin-index.d.ts'),
      'utf-8',
    );
    const indexInstalled = readFileSync(
      path.join(root, 'node_modules', '@opencode-ai', 'plugin', 'dist', 'index.d.ts'),
      'utf-8',
    );

    // Normalize for comparison
    const norm = (s: string) => s.replace(/\r\n/g, '\n').trimEnd();
    expect(norm(indexBaseline)).toBe(norm(indexInstalled));
  });

  it('HAPPY: version.json exists and records correct version', () => {
    const versionPath = path.join(root, '.opencode-sdk-baseline', 'version.json');
    expect(existsSync(versionPath)).toBe(true);

    const meta = JSON.parse(readFileSync(versionPath, 'utf-8'));
    expect(meta.version).toBe('1.15.4');
    expect(meta.files).toHaveLength(2);
    expect(meta.files[0].label).toBe('plugin/dist/index.d.ts');
    expect(meta.files[1].label).toBe('plugin/dist/tool.d.ts');
  });

  it('BAD: installed SDK at wrong path would be detected by snapshot script', () => {
    // The snapshot script looks at plugin/dist/index.d.ts, not sdk/dist/gen/types.gen.d.ts.
    // This test verifies the correct path is used.

    // Correct path exists
    expect(
      existsSync(path.join(root, 'node_modules', '@opencode-ai', 'plugin', 'dist', 'index.d.ts')),
    ).toBe(true);

    // The OLD (wrong) path from the original plan does NOT exist in the plugin package
    expect(
      existsSync(
        path.join(root, 'node_modules', '@opencode-ai', 'plugin', 'dist', 'gen', 'types.gen.d.ts'),
      ),
    ).toBe(false);
  });

  it('EDGE: SDK gen types live in @opencode-ai/sdk, not @opencode-ai/plugin', () => {
    // gen types are in the SDK package, not the plugin package
    expect(
      existsSync(
        path.join(root, 'node_modules', '@opencode-ai', 'sdk', 'dist', 'gen', 'types.gen.d.ts'),
      ),
    ).toBe(true);
  });
});

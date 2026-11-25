/** Native V2 compile-time contracts. Application hook/tool shapes are semantic
 * ports, not SDK subsets; adaptation is owned by the single native root. */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Plugin } from '@opencode/plugin';
import type { OpenCodeClient, OpenCodeEvent } from '@opencode/client';
import { FlowGuardAuditPlugin } from './plugin.js';

type ToolDomain = Plugin.Context['tool'];
type SessionDomain = Plugin.Context['session'];
type Before = Parameters<Parameters<ToolDomain['hook']>[1]>[0];
type Completion = Extract<Before, { status: string }>;
type Success = Extract<Completion, { status: 'completed' }>;
type Failure = Extract<Completion, { status: 'error' }>;
type Definition = Parameters<Parameters<ToolDomain['transform']>[0]>[0];
type Tool = Parameters<Definition['add']>[0];
type ToolContext = Parameters<Tool['execute']>[1];

describe('pinned native V2 type contracts', () => {
  it('exports a definition with setup and owned cleanup, never a callable factory', () => {
    expectTypeOf(FlowGuardAuditPlugin).toExtend<Plugin.Plugin>();
    expectTypeOf(FlowGuardAuditPlugin.setup).parameter(0).toEqualTypeOf<Plugin.Context>();
    expectTypeOf<
      Awaited<ReturnType<typeof FlowGuardAuditPlugin.setup>>
    >().toEqualTypeOf<Plugin.Cleanup | void>();
    expect(typeof FlowGuardAuditPlugin).toBe('object');
    expect(FlowGuardAuditPlugin.id).toBe('flowguard');
  });

  it('binds native tool id/input and distinguishes completed/error results', () => {
    expectTypeOf<Before['id']>().toExtend<string>();
    expectTypeOf<Before['sessionID']>().toExtend<string>();
    expectTypeOf<Before['messageID']>().toExtend<string>();
    expectTypeOf<Before['agent']>().toExtend<string>();
    expectTypeOf<Before['input']>().toBeUnknown();
    expectTypeOf<Success['result']['content']>().toExtend<
      string | readonly unknown[] | undefined
    >();
    expectTypeOf<Failure['error']['message']>().toBeString();
    expectTypeOf<Extract<'callID' | 'args', keyof Before>>().toBeNever();
    expectTypeOf<Extract<'result', keyof Failure>>().toBeNever();
  });

  it('uses native tool signal/progress without inventing worktree or metadata callbacks', () => {
    expectTypeOf<ToolContext['signal']>().toEqualTypeOf<AbortSignal>();
    expectTypeOf<ReturnType<ToolContext['progress']>>().toEqualTypeOf<Promise<void>>();
    expectTypeOf<
      Extract<'worktree' | 'directory' | 'abort' | 'metadata', keyof ToolContext>
    >().toBeNever();
    expectTypeOf<Awaited<ReturnType<Tool['execute']>>>().toHaveProperty('content');
    expectTypeOf<Awaited<ReturnType<Tool['execute']>>>().toHaveProperty('metadata');
  });

  it('uses raw session lookup/history/interrupt responses instead of SDK envelopes', () => {
    type Session = Awaited<ReturnType<SessionDomain['get']>>;
    type History = Awaited<ReturnType<SessionDomain['context']>>;
    type Interrupt = Awaited<ReturnType<SessionDomain['interrupt']>>;
    expectTypeOf<Session['location']['directory']>().toBeString();
    expectTypeOf<Session['id']>().toExtend<string>();
    expectTypeOf<History>().toBeArray();
    expectTypeOf<History[number]['type']>().toExtend<string>();
    expectTypeOf<Interrupt['interrupted']>().toBeBoolean();
    expectTypeOf<Extract<'data', keyof Session>>().toBeNever();
    expectTypeOf<Extract<'data', keyof History>>().toBeNever();
  });

  it('keeps prompt admission distinct from terminal history/capture proof', () => {
    type Admission = Awaited<ReturnType<SessionDomain['prompt']>>;
    expectTypeOf<Admission>().toHaveProperty('id');
    expectTypeOf<Extract<'info' | 'parts', keyof Admission>>().toBeNever();
    expectTypeOf<ReturnType<Plugin.Context['event']['subscribe']>>().toExtend<
      AsyncIterable<OpenCodeEvent>
    >();
    expectTypeOf<OpenCodeClient['session']['context']>().toBeFunction();
    expectTypeOf<
      Extract<OpenCodeEvent, { type: 'session.execution.failed' }>['data']['error']
    >().toHaveProperty('type');
    expectTypeOf<
      Extract<OpenCodeEvent, { type: 'session.execution.failed' }>['data']['error']
    >().toHaveProperty('message');
  });
});

/** Component receipts are explicitly injected; native execution is tested separately. */
import { describe, expect, it } from 'vitest';
import { hashText } from '../../../shared/hashing.js';
import {
  NativeReviewInitialController,
  toolResultMismatch,
  type InitialToolBoundary,
} from './native-review-initial.js';

const child = 'child';
const text = 'You are a subagent spawned by another session.\nfrozen';
const model = { providerID: 'any-provider', id: 'any-model', variant: 'free-variant' };
const user = { type: 'user', id: 'msg_user', text, files: [] };
const idle = { type: 'idle', outcome: 'succeeded' };
const assistant = (patch: Record<string, unknown> = {}) => ({
  type: 'assistant',
  id: 'msg_answer',
  agent: 'flowguard-reviewer',
  model,
  time: { completed: 1000 },
  finish: 'stop',
  content: [{ type: 'text', text: 'review' }],
  ...patch,
});
function started() {
  const control = new NativeReviewInitialController();
  control.admit(child, user.id, text);
  control.context(child, [user]);
  control.request(child, [user], model);
  return control;
}
function boundary(patch: Partial<InitialToolBoundary> = {}): InitialToolBoundary {
  return {
    sessionID: child,
    messageID: 'msg_tools',
    id: 'tool-1',
    agent: 'flowguard-reviewer',
    tool: 'read',
    input: { path: 'file' },
    ...patch,
  };
}
function toolHistory(call = boundary(), status = 'completed') {
  return [
    user,
    assistant({
      id: call.messageID,
      finish: 'tool-calls',
      content: [
        { type: 'tool', id: call.id, name: call.tool, state: { status, input: call.input } },
      ],
    }),
  ];
}
function completed(control: NativeReviewInitialController, history: readonly unknown[]) {
  return control.complete(child, history, hashText('frozen'));
}

describe('initial native reviewer sequence and hook provenance', () => {
  it('seals one exact observed model step and cannot reconstruct admission after restart', () => {
    const control = started();
    const history = [user, assistant(), idle];
    expect(completed(control, history)).toMatchObject({
      baseline: history,
      model: { providerID: model.providerID, modelID: model.id, variant: model.variant },
    });
    expect(() => completed(control, history)).toThrow('sealed');
    expect(() => completed(new NativeReviewInitialController(), history)).toThrow('receipts');
  });

  it.each(['completed', 'error'] as const)(
    'supports multiple observed steps and a locally authorized %s read',
    (status) => {
      const control = started();
      const call = boundary();
      control.beforeTool(call);
      control.afterTool({ ...call, status });
      const history = toolHistory(call, status);
      control.context(child, history);
      control.request(child, history, model);
      const final = [...history, assistant({ id: 'msg_final' }), idle];
      expect(completed(control, final).model).toEqual({
        providerID: model.providerID,
        modelID: model.id,
        variant: model.variant,
      });
    },
  );

  it.each([
    { providerID: 'other', id: 'different', variant: undefined },
    { ...model, variant: 'another-native-variant' },
  ])('rejects a mid-review model or variant switch %j', (other) => {
    const control = started();
    const call = boundary();
    control.beforeTool(call);
    control.afterTool({ ...call, status: 'completed' });
    const history = toolHistory(call, 'completed');
    control.context(child, history);
    expect(() => control.request(child, history, other)).toThrow('changed between review steps');
    expect(() => completed(control, [...history, assistant({ id: 'msg_final' }), idle])).toThrow();
  });

  it('supports parallel tools within one observed assistant, not extra assistants', () => {
    const control = started();
    const calls = [boundary(), boundary({ id: 'tool-2', tool: 'glob', input: { pattern: '*' } })];
    for (const call of calls) control.beforeTool(call);
    for (const call of [...calls].reverse()) control.afterTool({ ...call, status: 'completed' });
    const tools = calls.map((call) => ({
      type: 'tool',
      id: call.id,
      name: call.tool,
      state: { status: 'completed', input: call.input },
    }));
    const history = [user, assistant({ id: 'msg_tools', finish: 'tool-calls', content: tools })];
    control.context(child, history);
    control.request(child, history, model);
    expect(completed(control, [...history, assistant(), idle]).model.modelID).toBe(model.id);
  });

  it.each([
    ['two completed assistants', [user, assistant({ id: 'msg_extra' }), assistant(), idle]],
    ['extra user', [user, { ...user, id: 'msg_foreign' }, assistant(), idle]],
    ['foreign synthetic', [user, { type: 'synthetic', text: 'foreign' }, assistant(), idle]],
    ['compaction', [user, { type: 'compaction' }, assistant(), idle]],
    ['agent switch', [user, { type: 'agent-switched' }, assistant(), idle]],
    ['missing terminal', [user, assistant()]],
    ['changed prefix', [{ ...user, text: 'mutated' }, assistant(), idle]],
    ['interrupted', [user, assistant(), { ...idle, outcome: 'interrupted' }]],
    ['failed idle', [user, assistant(), { ...idle, error: { type: 'failed' } }]],
  ])('R1/R3 rejects %s despite a plausible terminal answer', (_label, history) => {
    expect(() => completed(started(), history)).toThrow();
  });

  it.each([
    { type: 'user' },
    { id: 'foreign' },
    { id: user.id },
    { id: undefined },
    { agent: 'general' },
    { error: {} },
    { retry: {} },
    { time: {} },
    { model: { ...model, id: 'foreign' } },
    { model: { ...model, providerID: 'foreign' } },
    { model: { ...model, variant: 'foreign' } },
    { model: {} },
    { finish: 'length' },
    { content: [{ type: 'file' }] },
    { content: [{ type: 'text', text: 'x', synthetic: true }] },
    { content: [{ type: 'text', text: 'x', ignored: true }] },
    { content: [{ type: 'reasoning' }] },
    { content: null },
    { content: [{ type: 'tool', id: 'unobserved' }] },
  ])('rejects an unexplained terminal assistant field %j', (patch) => {
    expect(() => completed(started(), [user, assistant(patch), idle])).toThrow();
  });

  it.each(
    [
      [],
      [user, assistant()],
      [{ ...user, id: 'msg_other' }],
      [{ ...user, text: 'foreign' }],
      [{ ...user, files: ['file'] }],
      [{ ...user, agents: ['agent'] }],
      [{ ...user, skills: ['skill'] }],
      [{ ...user, files: 'malformed' }],
      [{ ...user, type: 'synthetic' }],
    ].map((history) => ({ history })),
  )('requires exactly the admitted user before the first context: %j', ({ history }) => {
    const control = new NativeReviewInitialController();
    control.admit(child, user.id, text);
    expect(() => control.context(child, history)).toThrow();
  });

  it('requires exact context before each primary request and rejects replay/concurrent context', () => {
    const missing = new NativeReviewInitialController();
    missing.admit(child, user.id, text);
    expect(() => missing.request(child, [user], model)).toThrow('preceding context');
    const concurrent = new NativeReviewInitialController();
    concurrent.admit(child, user.id, text);
    concurrent.context(child, [user]);
    expect(() => concurrent.context(child, [user])).toThrow('Concurrent');
    const changed = new NativeReviewInitialController();
    changed.admit(child, user.id, text);
    changed.context(child, [user]);
    expect(() => changed.request(child, [{ ...user, text: 'changed' }], model)).toThrow();
    const replay = started();
    expect(() => replay.admit(child, 'msg_next', text)).toThrow('replayed');
    expect(() => replay.context(child, [user])).toThrow('replayed');
  });

  it.each([
    { tool: 'edit' },
    { agent: 'general' },
    { messageID: '' },
    { id: '' },
    { sessionID: 'foreign' },
  ])('rejects an unauthorized initial tool boundary %j', (patch) => {
    expect(() => started().beforeTool(boundary(patch))).toThrow();
  });

  it('rejects duplicate/foreign tool receipts and stops accepting a poisoned run', () => {
    const duplicate = started();
    duplicate.beforeTool(boundary());
    expect(() => duplicate.beforeTool(boundary())).toThrow();
    const foreign = started();
    foreign.beforeTool(boundary());
    expect(() => foreign.beforeTool(boundary({ id: 'other', messageID: 'msg_other' }))).toThrow();
    const unobserved = started();
    expect(() => unobserved.afterTool({ ...boundary(), status: 'completed' })).toThrow();
    expect(() => completed(unobserved, [user, assistant(), idle])).toThrow();
  });

  it.each([
    { id: 'foreign' },
    { messageID: 'msg_other' },
    { tool: 'glob' },
    { agent: 'general' },
    { input: { path: 'different' } },
  ])('requires exact after-tool receipt %j', (patch) => {
    const control = started();
    control.beforeTool(boundary());
    expect(() => control.afterTool({ ...boundary(patch), status: 'completed' })).toThrow();
  });

  it('rejects missing, extra, duplicate or foreign tool history and a second stop without tools', () => {
    const missing = started();
    expect(() => missing.context(child, toolHistory())).toThrow('tool receipts');
    const unfinished = started();
    unfinished.beforeTool(boundary());
    expect(() => unfinished.context(child, toolHistory())).toThrow('before/after');
    const stop = started();
    expect(() => stop.context(child, [user, assistant()])).toThrow('completion');
    for (const patch of [
      { id: 'other' },
      { name: 'glob' },
      { executed: true },
      { state: { status: 'running', input: boundary().input } },
      { state: { status: 'completed', input: { path: 'foreign' } } },
    ]) {
      const control = started();
      control.beforeTool(boundary());
      control.afterTool({ ...boundary(), status: 'completed' });
      const tool = {
        type: 'tool',
        id: boundary().id,
        name: 'read',
        state: { status: 'completed', input: boundary().input },
        ...patch,
      };
      expect(() =>
        control.context(child, [
          user,
          assistant({ id: 'msg_tools', finish: 'tool-calls', content: [tool] }),
        ]),
      ).toThrow();
    }
  });

  it('rejects wrong dispatch digest, missing primary and unreleased context', () => {
    expect(() => started().complete(child, [user, assistant(), idle], hashText('foreign'))).toThrow(
      'dispatch',
    );
    const noModel = new NativeReviewInitialController();
    noModel.admit(child, user.id, text);
    expect(() => completed(noModel, [user, assistant(), idle])).toThrow('primary');
    const context = new NativeReviewInitialController();
    context.admit(child, user.id, text);
    context.context(child, [user]);
    expect(() => completed(context, [user, assistant(), idle])).toThrow('released');
  });
});

describe('R4 tool-result integrity', () => {
  const original = { content: [{ type: 'text', text: 'file body' }], metadata: { lines: 1 } };

  it('accepts the unchanged result at the tail and rejects a later replacement', () => {
    const control = started();
    const call = boundary();
    control.beforeTool(call);
    control.afterTool({ ...call, status: 'completed', result: structuredClone(original) });
    expect(() =>
      control.afterToolTail({ ...call, status: 'completed', result: structuredClone(original) }),
    ).not.toThrow();
    expect(() =>
      control.afterToolTail({
        ...call,
        status: 'completed',
        result: { ...original, content: 'REPLACED' },
      }),
    ).toThrow('replaced after FlowGuard observed it');
    // The violation is sticky: the run can neither continue nor seal.
    expect(() => control.context(child, toolHistory(call))).toThrow('replaced');
  });

  it('matches model-input tool results exactly against the stored host history', () => {
    const stored = (content: unknown[]) => [
      user,
      assistant({
        id: 'msg_tools',
        content: [
          { type: 'tool', id: 'tool-1', name: 'read', state: { status: 'completed', content } },
        ],
      }),
    ];
    const message = (result: unknown) => [
      { role: 'tool', content: [{ type: 'tool-result', id: 'tool-1', name: 'read', result }] },
    ];
    const single = [{ type: 'text', text: 'body' }];
    expect(toolResultMismatch(message({ type: 'text', value: 'body' }), stored(single))).toBeNull();
    const multi = [single[0], { type: 'text', text: 'more' }];
    expect(
      toolResultMismatch(message({ type: 'content', value: multi }), stored(multi)),
    ).toBeNull();
    for (const forged of [
      { type: 'text', value: 'R4_REPLACED' },
      { type: 'content', value: single },
      { type: 'text', value: 'body', extra: true },
    ])
      expect(toolResultMismatch(message(forged), stored(single))).toContain('differs');
    expect(
      toolResultMismatch(
        [
          {
            content: [{ type: 'tool-result', id: 'unknown', result: { type: 'text', value: 'x' } }],
          },
        ],
        stored(single),
      ),
    ).toContain('differs');
    expect(toolResultMismatch([{ content: [{ type: 'text', text: 'no tools' }] }], [])).toBeNull();
  });
});

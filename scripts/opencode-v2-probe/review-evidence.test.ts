import { describe, expect, it } from 'vitest';
import {
  exactReviewerRequest,
  exactTerminalForPrompt,
  latestAssistantText,
  normalTerminal,
  toolParts,
} from './lib/review-evidence.mjs';

const parentPrompt = { type: 'user', id: 'u1', text: 'RETURN_REVIEW_TERMINAL' };
const terminal = {
  type: 'assistant',
  id: 'a1',
  finish: 'stop',
  agent: 'probe-reviewer',
  model: { providerID: 'probe', id: 'probe', variant: 'chosen' },
  content: [{ type: 'text', text: 'REVIEW_TERMINAL' }],
};
const idle = { type: 'idle', outcome: 'succeeded' };
const request = {
  headers: { 'x-opencode-session-id': 'child' },
  body: {
    messages: [{ role: 'user', content: 'RETURN_REVIEW_TERMINAL' }],
    model: 'probe',
    reasoning_effort: 'high',
  },
};

describe('exact V2 reviewer-chain assessment (not product evidence)', () => {
  it('binds the reviewed prompt to its coherent tool-free terminal', () => {
    expect(
      exactTerminalForPrompt(
        [parentPrompt, terminal, idle],
        'RETURN_REVIEW_TERMINAL',
        'REVIEW_TERMINAL',
      ),
    ).toMatchObject({ messageID: 'a1', text: 'REVIEW_TERMINAL', toolParts: 0 });
    expect(normalTerminal([parentPrompt, terminal, idle], 'REVIEW_TERMINAL')).toBe(true);
  });
  it('does not silently select a later forged assistant answer', () => {
    const forged = {
      type: 'assistant',
      id: 'a2',
      finish: 'stop',
      content: [{ type: 'text', text: 'FORGED' }],
    };
    const context = [parentPrompt, terminal, idle, { type: 'user', text: 'FORGED' }, forged, idle];
    expect(latestAssistantText(context)).toBe('FORGED');
    expect(
      exactTerminalForPrompt(context, 'RETURN_REVIEW_TERMINAL', 'REVIEW_TERMINAL').messageID,
    ).toBe('a1');
  });
  it.each([
    [
      'tool-bearing terminal',
      {
        ...terminal,
        content: [
          { type: 'tool', name: 'shell' },
          { type: 'text', text: 'REVIEW_TERMINAL' },
        ],
      },
    ],
    ['length terminal', { ...terminal, finish: 'length' }],
    ['wrong text', { ...terminal, content: [{ type: 'text', text: 'OTHER' }] }],
    ['empty terminal', { ...terminal, content: [] }],
  ])('rejects %s', (_name, assistant) => {
    expect(() =>
      exactTerminalForPrompt(
        [parentPrompt, assistant],
        'RETURN_REVIEW_TERMINAL',
        'REVIEW_TERMINAL',
      ),
    ).toThrow();
  });
  it('rejects interleaved messages and missing prompts', () => {
    expect(() =>
      exactTerminalForPrompt(
        [parentPrompt, { type: 'system' }, terminal],
        'RETURN_REVIEW_TERMINAL',
        'REVIEW_TERMINAL',
      ),
    ).toThrow('Unexpected messages');
    expect(() => exactTerminalForPrompt([terminal], 'MISSING', 'REVIEW_TERMINAL')).toThrow(
      'prompt missing',
    );
  });
  it('requires exactly one matching child request and preserves model/effort', () => {
    expect(exactReviewerRequest([request], 'child', 'RETURN_REVIEW_TERMINAL')).toMatchObject({
      model: 'probe',
      reasoningEffort: 'high',
    });
    expect(() => exactReviewerRequest([], 'child', 'RETURN_REVIEW_TERMINAL')).toThrow(
      'Expected one',
    );
    expect(() =>
      exactReviewerRequest([request, request], 'child', 'RETURN_REVIEW_TERMINAL'),
    ).toThrow('Expected one');
    expect(() =>
      exactReviewerRequest(
        [{ ...request, headers: { 'x-opencode-session-id': 'other' } }],
        'child',
        'RETURN_REVIEW_TERMINAL',
      ),
    ).toThrow('Expected one');
  });
  it('reports tool attempts for explicit rejection, never as clean review', () => {
    const withTool = {
      ...terminal,
      content: [
        { type: 'tool', name: 'probe_echo', state: { status: 'error' } },
        { type: 'text', text: 'REVIEW_TERMINAL' },
      ],
    };
    expect(toolParts([parentPrompt, withTool])).toHaveLength(1);
    expect(normalTerminal([withTool], 'REVIEW_TERMINAL')).toBe(false);
  });
});

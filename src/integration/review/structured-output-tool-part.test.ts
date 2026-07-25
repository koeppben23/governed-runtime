/**
 * @module integration/review/structured-output-tool-part.test
 * @description Fail-closed guards for StructuredOutput tool-part extraction.
 */

import { describe, it, expect } from 'vitest';

import { extractStructuredOutputToolPart } from './structured-output-tool-part.js';

function toolPart(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'tool',
    tool: 'StructuredOutput',
    callID: 'call-1',
    state: {
      status: 'completed',
      input: { verdict: 'accept' },
      metadata: { valid: true },
    },
    ...overrides,
  };
}

describe('extractStructuredOutputToolPart', () => {
  it('returns the input object of a completed, validated StructuredOutput part', () => {
    const result = extractStructuredOutputToolPart([toolPart()]);
    expect(result).toEqual({ verdict: 'accept' });
  });

  it('ignores non-StructuredOutput tool parts and finds the right one', () => {
    const parts = [
      { type: 'tool', tool: 'SomethingElse', state: { status: 'completed', input: { x: 1 } } },
      toolPart(),
    ];
    expect(extractStructuredOutputToolPart(parts)).toEqual({ verdict: 'accept' });
  });

  // ── Fail-closed guards ──────────────────────────────────────────────────────

  it('returns null when parts is undefined', () => {
    expect(extractStructuredOutputToolPart(undefined)).toBeNull();
  });

  it('returns null for an empty parts array', () => {
    expect(extractStructuredOutputToolPart([])).toBeNull();
  });

  it('rejects a plain text part (never a structured substitute)', () => {
    const parts = [{ type: 'text', text: JSON.stringify({ verdict: 'accept' }) }];
    expect(extractStructuredOutputToolPart(parts)).toBeNull();
  });

  it('rejects a tool part with the wrong tool name', () => {
    expect(extractStructuredOutputToolPart([toolPart({ tool: 'OtherTool' })])).toBeNull();
  });

  it('rejects a tool part whose status is not completed', () => {
    const part = toolPart({
      state: { status: 'running', input: { verdict: 'accept' }, metadata: { valid: true } },
    });
    expect(extractStructuredOutputToolPart([part])).toBeNull();
  });

  it('rejects when metadata.valid is not strictly true', () => {
    const partFalse = toolPart({
      state: { status: 'completed', input: { verdict: 'accept' }, metadata: { valid: false } },
    });
    const partMissing = toolPart({
      state: { status: 'completed', input: { verdict: 'accept' }, metadata: {} },
    });
    const partTruthy = toolPart({
      state: { status: 'completed', input: { verdict: 'accept' }, metadata: { valid: 'yes' } },
    });
    expect(extractStructuredOutputToolPart([partFalse])).toBeNull();
    expect(extractStructuredOutputToolPart([partMissing])).toBeNull();
    expect(extractStructuredOutputToolPart([partTruthy])).toBeNull();
  });

  it('rejects when state is missing entirely', () => {
    expect(extractStructuredOutputToolPart([toolPart({ state: undefined })])).toBeNull();
  });

  it('rejects when input is an array', () => {
    const part = toolPart({
      state: { status: 'completed', input: [1, 2, 3], metadata: { valid: true } },
    });
    expect(extractStructuredOutputToolPart([part])).toBeNull();
  });

  it('rejects a part with the StructuredOutput tool name but a non-tool type', () => {
    // Guards the `part.type !== 'tool'` check independently of the tool name.
    const part = toolPart({ type: 'text' });
    expect(extractStructuredOutputToolPart([part])).toBeNull();
  });

  it('rejects when input is a primitive or null', () => {
    const partString = toolPart({
      state: { status: 'completed', input: 'accept', metadata: { valid: true } },
    });
    const partNull = toolPart({
      state: { status: 'completed', input: null, metadata: { valid: true } },
    });
    expect(extractStructuredOutputToolPart([partString])).toBeNull();
    expect(extractStructuredOutputToolPart([partNull])).toBeNull();
  });
});

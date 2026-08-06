import { describe, it, expect } from 'vitest';
import { EvalCaseSchema } from '../schema.js';

describe('EvalCaseSchema', () => {
  it('accepts a valid workspace case', () => {
    const result = EvalCaseSchema.safeParse({
      id: 'test-case',
      description: 'A test case',
      task: 'Do something',
      mode: 'workspace',
      workspace: { mode: 'fixture', fixture: 'my-fixture' },
      assertions: [
        {
          type: 'output_contains',
          value: 'expected',
          description: 'should contain expected',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid output-only case', () => {
    const result = EvalCaseSchema.safeParse({
      id: 'test-case',
      description: 'A test case',
      task: 'Do something',
      mode: 'output-only',
      assertions: [
        {
          type: 'output_not_contains',
          value: 'forbidden',
          description: 'should not contain forbidden',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects workspace case without fixture', () => {
    const result = EvalCaseSchema.safeParse({
      id: 'test-case',
      description: 'A test case',
      task: 'Do something',
      mode: 'workspace',
      assertions: [
        {
          type: 'exit_code',
          value: 0,
          description: 'exit 0',
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects output-only case with fixture mode', () => {
    const result = EvalCaseSchema.safeParse({
      id: 'test-case',
      description: 'A test case',
      task: 'Do something',
      mode: 'output-only',
      workspace: { mode: 'fixture', fixture: 'x' },
      assertions: [
        {
          type: 'exit_code',
          value: 0,
          description: 'exit 0',
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('defaults severity to hard', () => {
    const result = EvalCaseSchema.safeParse({
      id: 'test-case',
      description: 'A test case',
      task: 'Do something',
      mode: 'output-only',
      assertions: [
        {
          type: 'output_contains',
          value: 'x',
          description: 'contains x',
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.assertions[0].severity).toBe('hard');
    }
  });

  it('accepts advisory severity', () => {
    const result = EvalCaseSchema.safeParse({
      id: 'test-case',
      description: 'A test case',
      task: 'Do something',
      mode: 'output-only',
      assertions: [
        {
          type: 'output_contains',
          value: 'x',
          severity: 'advisory',
          description: 'contains x (advisory)',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty assertions array', () => {
    const result = EvalCaseSchema.safeParse({
      id: 'test-case',
      description: 'A test case',
      task: 'Do something',
      mode: 'output-only',
      assertions: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects file assertion path with traversal', () => {
    const result = EvalCaseSchema.safeParse({
      id: 'test-case',
      description: 'A test case',
      task: 'Do something',
      mode: 'workspace',
      workspace: { mode: 'fixture', fixture: 'ok-fixture' },
      assertions: [
        {
          type: 'file_changed',
          path: '../../outside.txt',
          severity: 'hard',
          description: 'should be rejected',
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

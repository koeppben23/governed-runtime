import { describe, it, expect } from 'vitest';
import { EvalCaseSchema } from '../schema.js';

describe('EvalCaseSchema', () => {
  it('accepts a valid workspace contributor case', () => {
    const result = EvalCaseSchema.safeParse({
      id: 'test-case',
      description: 'A test case',
      instructionSurface: 'repository_contributor',
      task: 'Do something',
      mode: 'workspace',
      workspace: { mode: 'fixture' },
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

  it('accepts a valid output-only contributor case', () => {
    const result = EvalCaseSchema.safeParse({
      id: 'test-case',
      description: 'A test case',
      instructionSurface: 'repository_contributor',
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

  it('rejects workspace case without fixture mode', () => {
    const result = EvalCaseSchema.safeParse({
      id: 'test-case',
      description: 'A test case',
      instructionSurface: 'repository_contributor',
      task: 'Do something',
      mode: 'workspace',
      assertions: [{ type: 'exit_code', value: 0, description: 'exit 0' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects output-only case with fixture mode', () => {
    const result = EvalCaseSchema.safeParse({
      id: 'test-case',
      description: 'A test case',
      instructionSurface: 'repository_contributor',
      task: 'Do something',
      mode: 'output-only',
      workspace: { mode: 'fixture' },
      assertions: [{ type: 'exit_code', value: 0, description: 'exit 0' }],
    });
    expect(result.success).toBe(false);
  });

  it('defaults assertion severity to hard without defaulting instruction authority', () => {
    const result = EvalCaseSchema.safeParse({
      id: 'test-case',
      description: 'A test case',
      instructionSurface: 'repository_contributor',
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
      expect(result.data.instructionSurface).toBe('repository_contributor');
    }
  });

  it('rejects a case with no explicit instruction surface', () => {
    const result = EvalCaseSchema.safeParse({
      id: 'test-case',
      description: 'A test case',
      task: 'Do something',
      mode: 'output-only',
      assertions: [{ type: 'exit_code', value: 0, description: 'exit 0' }],
    });
    expect(result.success).toBe(false);
  });

  it.each(['opencode', 'claude-code', 'codex'] as const)(
    'accepts a FlowGuard product case for supported host %s',
    (instructionHost) => {
      const result = EvalCaseSchema.safeParse({
        id: `product-${instructionHost}`,
        description: 'A customer runtime mandate case',
        instructionSurface: 'flowguard_product',
        instructionHost,
        task: 'Do something',
        mode: 'output-only',
        assertions: [{ type: 'exit_code', value: 0, description: 'exit 0' }],
      });
      expect(result.success).toBe(true);
    },
  );

  it('rejects an unsupported product host', () => {
    const result = EvalCaseSchema.safeParse({
      id: 'product-case',
      description: 'A customer runtime mandate case',
      instructionSurface: 'flowguard_product',
      instructionHost: 'unknown-host',
      task: 'Do something',
      mode: 'output-only',
      assertions: [{ type: 'exit_code', value: 0, description: 'exit 0' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a FlowGuard product case without an instruction host', () => {
    const result = EvalCaseSchema.safeParse({
      id: 'product-case',
      description: 'A customer runtime mandate case',
      instructionSurface: 'flowguard_product',
      task: 'Do something',
      mode: 'output-only',
      assertions: [{ type: 'exit_code', value: 0, description: 'exit 0' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects product host metadata on contributor cases', () => {
    const result = EvalCaseSchema.safeParse({
      id: 'contributor-case',
      description: 'A repository contributor case',
      instructionSurface: 'repository_contributor',
      instructionHost: 'opencode',
      task: 'Do something',
      mode: 'output-only',
      assertions: [{ type: 'exit_code', value: 0, description: 'exit 0' }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts advisory severity', () => {
    const result = EvalCaseSchema.safeParse({
      id: 'test-case',
      description: 'A test case',
      instructionSurface: 'repository_contributor',
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
      instructionSurface: 'repository_contributor',
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
      instructionSurface: 'repository_contributor',
      task: 'Do something',
      mode: 'workspace',
      workspace: { mode: 'fixture' },
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

  it('rejects Windows drive-absolute file assertion paths', () => {
    const result = EvalCaseSchema.safeParse({
      id: 'test-case',
      description: 'A test case',
      instructionSurface: 'repository_contributor',
      task: 'Do something',
      mode: 'workspace',
      workspace: { mode: 'fixture' },
      assertions: [
        {
          type: 'file_changed',
          path: 'C:\\outside.txt',
          severity: 'hard',
          description: 'drive-absolute paths must be rejected',
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

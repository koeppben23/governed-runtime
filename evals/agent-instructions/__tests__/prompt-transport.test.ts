import { describe, it, expect } from 'vitest';
import { RunnerConfigSchema } from '../schema.js';

describe('RunnerConfigSchema — prompt transport', () => {
  it('accepts stdin transport', () => {
    const r = RunnerConfigSchema.safeParse({
      name: 'test',
      command: 'node',
      promptTransport: 'stdin',
      args: [],
    });
    expect(r.success).toBe(true);
  });

  it('accepts argument transport with exactly one {prompt}', () => {
    const r = RunnerConfigSchema.safeParse({
      name: 'test',
      command: 'node',
      promptTransport: 'argument',
      args: ['run', '--prompt', '{prompt}'],
    });
    expect(r.success).toBe(true);
  });

  it('rejects argument transport with zero {prompt}', () => {
    const r = RunnerConfigSchema.safeParse({
      name: 'test',
      command: 'node',
      promptTransport: 'argument',
      args: ['run'],
    });
    expect(r.success).toBe(false);
  });

  it('rejects argument transport with multiple {prompt}', () => {
    const r = RunnerConfigSchema.safeParse({
      name: 'test',
      command: 'node',
      promptTransport: 'argument',
      args: ['{prompt}', '{prompt}'],
    });
    expect(r.success).toBe(false);
  });

  it('defaults staticEnv and secretEnvNames', () => {
    const r = RunnerConfigSchema.safeParse({
      name: 'test',
      command: 'echo',
      promptTransport: 'stdin',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.staticEnv).toEqual({});
      expect(r.data.secretEnvNames).toEqual([]);
    }
  });

  it('rejects invalid secretEnvNames', () => {
    const r = RunnerConfigSchema.safeParse({
      name: 'test',
      command: 'echo',
      promptTransport: 'stdin',
      secretEnvNames: ['bad name', '123'],
    });
    expect(r.success).toBe(false);
  });
});

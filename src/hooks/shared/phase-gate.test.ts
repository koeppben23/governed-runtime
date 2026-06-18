import { describe, it, expect } from 'vitest';
import { isSubagentAuthorized } from './phase-gate.js';

describe('isSubagentAuthorized', () => {
  it('allows non-task tools', () => {
    const result = isSubagentAuthorized('bash', {});
    expect(result.allowed).toBe(true);
  });

  it('allows task tool without subagent_type', () => {
    const result = isSubagentAuthorized('task', {});
    expect(result.allowed).toBe(true);
  });

  it('allows task tool with undefined subagent_type', () => {
    const result = isSubagentAuthorized('task', { subagent_type: undefined });
    expect(result.allowed).toBe(true);
  });

  it('allows task tool with null subagent_type', () => {
    const result = isSubagentAuthorized('task', { subagent_type: null });
    expect(result.allowed).toBe(true);
  });

  it('denies subagent_type that is a number', () => {
    const result = isSubagentAuthorized('task', { subagent_type: 42 });
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('SUBAGENT_TYPE_UNAUTHORIZED');
    expect(result.reason).toContain('number');
  });

  it('denies subagent_type that is a boolean', () => {
    const result = isSubagentAuthorized('task', { subagent_type: true });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('boolean');
  });

  it('denies subagent_type that is an object', () => {
    const result = isSubagentAuthorized('task', { subagent_type: { name: 'evil' } });
    expect(result.allowed).toBe(false);
  });

  it('denies subagent_type that is an array', () => {
    const result = isSubagentAuthorized('task', { subagent_type: ['x'] });
    expect(result.allowed).toBe(false);
  });

  it('allows empty string subagent_type', () => {
    const result = isSubagentAuthorized('task', { subagent_type: '' });
    expect(result.allowed).toBe(true);
  });

  it('allows authorized reviewer subagent_type', () => {
    const result = isSubagentAuthorized('task', { subagent_type: 'flowguard-reviewer' });
    expect(result.allowed).toBe(true);
  });

  it('denies unauthorized subagent_type string', () => {
    const result = isSubagentAuthorized('task', { subagent_type: 'malicious-agent' });
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('SUBAGENT_TYPE_UNAUTHORIZED');
    expect(result.reason).toContain('malicious-agent');
  });
});

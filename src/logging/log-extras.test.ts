/**
 * @module logging/log-extras.test
 * @description Tests for typed log helper functions.
 *
 * Covers:
 * - Runtime forwarding: each helper calls the correct logger method
 *   with correct service, level, message, and extra.
 * - Type checks: verify that wrong types are rejected at compile time.
 *
 * @test-policy HAPPY, BAD
 * @version v1
 */

import { describe, it, expect } from 'vitest';
import type { FlowGuardLogger } from './logger.js';
import {
  logAudit,
  logEnforcement,
  logEnforcementDebug,
  logHook,
  logOrchestrator,
} from './log-extras.js';

function mockLogger(): { log: FlowGuardLogger; calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const log: FlowGuardLogger = {
    debug: (s, m, e) => calls.push({ method: 'debug', args: [s, m, e] }),
    info: (s, m, e) => calls.push({ method: 'info', args: [s, m, e] }),
    warn: (s, m, e) => calls.push({ method: 'warn', args: [s, m, e] }),
    error: (s, m, e) => calls.push({ method: 'error', args: [s, m, e] }),
  };
  return { log, calls };
}

describe('logAudit', () => {
  it('forwards to log.info with correct service', () => {
    const { log, calls } = mockLogger();
    logAudit(log, 'info', 'test', { tool: 'hydrate' });
    expect(calls[0]!.method).toBe('info');
    expect(calls[0]!.args[0]).toBe('audit');
    expect(calls[0]!.args[1]).toBe('test');
    expect(calls[0]!.args[2]).toEqual({ tool: 'hydrate' });
  });

  it('forwards to log.debug with hash prefixes', () => {
    const { log, calls } = mockLogger();
    logAudit(log, 'debug', 'chain hash', {
      prevHashPrefix: 'abc12345',
      nextHashPrefix: 'def67890',
    });
    expect(calls[0]!.method).toBe('debug');
    expect(calls[0]!.args[2]).toHaveProperty('prevHashPrefix', 'abc12345');
    expect(calls[0]!.args[2]).toHaveProperty('nextHashPrefix', 'def67890');
  });

  it('forwards to log.error with SerializedError', () => {
    const { log, calls } = mockLogger();
    logAudit(log, 'error', 'failed', { error: { name: 'Error', message: 'boom' } });
    expect(calls[0]!.method).toBe('error');
    expect((calls[0]!.args[2] as Record<string, unknown>).error).toBeDefined();
  });
});

describe('logEnforcement', () => {
  it('forwards to log.warn with enforcement fields', () => {
    const { log, calls } = mockLogger();
    logEnforcement(log, 'warn', 'blocked', { code: 'E1', tool: 'bash' });
    expect(calls[0]!.method).toBe('warn');
    expect(calls[0]!.args[0]).toBe('enforcement');
    expect(calls[0]!.args[1]).toBe('blocked');
    expect(calls[0]!.args[2]).toEqual({ code: 'E1', tool: 'bash' });
  });

  it.skip('rejects info level at compile time', () => {
    // This test documents the compile-time constraint.
    // The line below produces a type error — verified by @ts-expect-error.
    // @ts-expect-error: 'info' is not assignable to 'warn' | 'error'
    logEnforcement(mockLogger().log, 'info', 'msg', {});
  });
});

describe('logEnforcementDebug', () => {
  it('forwards to log.debug with enforcement extra', () => {
    const { log, calls } = mockLogger();
    logEnforcementDebug(log, 'phase gate eval', {
      tool: 'bash',
      phase: 'IMPLEMENT',
      allowed: true,
    });
    expect(calls[0]!.method).toBe('debug');
    expect(calls[0]!.args[0]).toBe('enforcement');
    expect((calls[0]!.args[2] as Record<string, unknown>).allowed).toBe(true);
  });
});

describe('logHook', () => {
  it('forwards to log.info with hook extra', () => {
    const { log, calls } = mockLogger();
    logHook(log, 'tool.execute.before', { tool: 'hydrate' });
    expect(calls[0]!.method).toBe('info');
    expect(calls[0]!.args[0]).toBe('hook');
    expect(calls[0]!.args[2]).toEqual({ tool: 'hydrate' });
  });
});

describe('logOrchestrator', () => {
  it('forwards to log.debug with pipeline step', () => {
    const { log, calls } = mockLogger();
    logOrchestrator(log, 'debug', 'pipeline step', {
      tool: 'flowguard_implement',
      step: 'validate',
      iteration: 2,
    });
    expect(calls[0]!.method).toBe('debug');
    expect(calls[0]!.args[0]).toBe('orchestrator');
    expect((calls[0]!.args[2] as Record<string, unknown>).step).toBe('validate');
    expect((calls[0]!.args[2] as Record<string, unknown>).iteration).toBe(2);
  });
});

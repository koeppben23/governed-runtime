/**
 * @module logging/__tests__/boundary-logging
 * @description Contract tests for boundary logging at choke points.
 *
 * Verifies that formatted tool results emit diagnostic log events
 * without altering the output. Tests the format layer (formatRailResult,
 * formatBlocked). The transitions_applied logpoint in persistAndFormat
 * is exercised by the full integration test suite (persistAndFormat
 * requires validated state + filesystem, making direct unit testing
 * impractical without a full session fixture).
 *
 * @test-policy HAPPY, CORNER — log events are diagnostic, not governance.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setAdapterLogger, resetAdapterLogger, type AdapterLogger } from '../adapter-logger.js';

vi.mock('../../adapters/persistence.js', () => ({
  readState: vi.fn(),
  writeState: vi.fn().mockResolvedValue(undefined),
  writeStateAlreadyLocked: vi.fn().mockResolvedValue(undefined),
  PersistenceError: class extends Error {
    readonly code: string;
    constructor(code: string, msg: string) {
      super(msg);
      this.code = code;
    }
  },
}));

vi.mock('../../adapters/persistence-lock.js', () => ({
  acquireSessionWriteLock: vi
    .fn()
    .mockResolvedValue({ release: vi.fn().mockResolvedValue(undefined), waited: false }),
  withSessionWriteLock: vi
    .fn()
    .mockImplementation(async (_sessDir: string, fn: (lock: unknown) => Promise<unknown>) =>
      fn({ release: vi.fn(), waited: false }),
    ),
}));

function captureLogger(): {
  log: AdapterLogger;
  entries: { level: string; service: string; message: string; extra?: Record<string, unknown> }[];
} {
  const entries: {
    level: string;
    service: string;
    message: string;
    extra?: Record<string, unknown>;
  }[] = [];
  return {
    log: {
      info(svc, msg, ext) {
        entries.push({ level: 'info', service: svc, message: msg, extra: ext });
      },
      warn(svc, msg, ext) {
        entries.push({ level: 'warn', service: svc, message: msg, extra: ext });
      },
      error(svc, msg, ext) {
        entries.push({ level: 'error', service: svc, message: msg, extra: ext });
      },
      warnOnce: () => {},
    },
    entries,
  };
}

describe('boundary-logging', () => {
  beforeEach(() => {
    resetAdapterLogger();
  });

  describe('HAPPY — formatRailResult blocked emits warn', () => {
    it('logs warn on blocked rail result and returns unchanged output', async () => {
      const { log, entries } = captureLogger();
      setAdapterLogger(log);
      const { formatRailResult } = await import('../../integration/tools/helpers.js');

      const result = formatRailResult({
        kind: 'blocked',
        code: 'COMMAND_NOT_ALLOWED',
        reason: 'test reason',
      });

      expect(entries).toHaveLength(1);
      expect(entries[0]!.level).toBe('warn');
      expect(entries[0]!.service).toBe('machine');
      expect(entries[0]!.message).toBe('tool_blocked');
      expect(entries[0]!.extra).toMatchObject({ code: 'COMMAND_NOT_ALLOWED' });
      expect(typeof result).toBe('string');
      const parsed = JSON.parse(result as string);
      expect(parsed.error).toBe(true);
      expect(parsed.code).toBe('COMMAND_NOT_ALLOWED');
    });

    it('includes overflowLimit when overflow is present', async () => {
      const { log, entries } = captureLogger();
      setAdapterLogger(log);
      const { formatRailResult } = await import('../../integration/tools/helpers.js');

      formatRailResult({
        kind: 'blocked',
        code: 'AUTO_ADVANCE_OVERFLOW',
        reason: 'topology overflow',
        overflow: { phase: 'PLAN', limit: 10 },
      });

      expect(entries[0]!.extra).toMatchObject({
        code: 'AUTO_ADVANCE_OVERFLOW',
        overflowLimit: 10,
      });
    });
  });

  describe('HAPPY — formatBlocked emits warn', () => {
    it('logs warn with code', async () => {
      const { log, entries } = captureLogger();
      setAdapterLogger(log);
      const { formatBlocked } = await import('../../integration/tools/helpers.js');

      const result = formatBlocked('TICKET_REQUIRED');

      expect(entries).toHaveLength(1);
      expect(entries[0]!.level).toBe('warn');
      expect(entries[0]!.service).toBe('machine');
      expect(entries[0]!.message).toBe('tool_blocked');
      expect(entries[0]!.extra).toEqual({ code: 'TICKET_REQUIRED' });
      expect(typeof result).toBe('string');
    });
  });

  describe('CORNER — noop logger does not alter control flow', () => {
    it('blocked result unchanged when no adapter logger is set', async () => {
      const { formatRailResult } = await import('../../integration/tools/helpers.js');

      const result = formatRailResult({
        kind: 'blocked',
        code: 'TICKET_REQUIRED',
        reason: 'needs ticket',
      });

      const parsed = JSON.parse(result as string);
      expect(parsed.error).toBe(true);
      expect(parsed.code).toBe('TICKET_REQUIRED');
    });

    it('formatBlocked result unchanged when no adapter logger is set', async () => {
      const { formatBlocked } = await import('../../integration/tools/helpers.js');

      const result = formatBlocked('TICKET_REQUIRED');
      const parsed = JSON.parse(result);
      expect(parsed.code).toBe('TICKET_REQUIRED');
    });
  });
});

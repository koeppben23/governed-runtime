/**
 * @module logging/__tests__/log-sanitization
 * @description Verifies that new boundary-logging logpoints do not leak
 *              secrets, paths, command output, or raw error strings.
 *
 * Each test checks a specific new logpoint introduced in the
 * harden/logging-boundary-coverage change set. Only new logpoints are tested.
 *
 * @test-policy HAPPY — diagnostic logs must be safe at the call site.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { setAdapterLogger, resetAdapterLogger, type AdapterLogger } from '../adapter-logger.js';
import { runWithLogContext } from '../log-context.js';

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
    entries,
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
  };
}

describe('log-sanitization', () => {
  beforeEach(() => {
    resetAdapterLogger();
  });

  describe('HAPPY — formatBlocked does not leak args', () => {
    it('logs only code, no vars content', async () => {
      const { log, entries } = captureLogger();
      setAdapterLogger(log);
      const { formatBlocked } = await import('../../integration/tools/helpers.js');

      formatBlocked('TICKET_REQUIRED', { action: '/some/internal/path' });

      expect(entries).toHaveLength(1);
      expect(entries[0]!.extra).toEqual({ code: 'TICKET_REQUIRED' });
      expect(JSON.stringify(entries[0]!.extra)).not.toContain('/some/internal/path');
    });

    it('keeps traceId and durationMs as safe structured fields', async () => {
      const { log, entries } = captureLogger();
      setAdapterLogger(log);
      const { formatBlocked } = await import('../../integration/tools/helpers.js');

      runWithLogContext({ traceId: '11111111-1111-4111-8111-111111111111' }, () => {
        formatBlocked('TICKET_REQUIRED', { action: '/some/internal/path' });
      });

      expect(entries[0]!.extra).toMatchObject({
        code: 'TICKET_REQUIRED',
        traceId: '11111111-1111-4111-8111-111111111111',
      });
      expect(JSON.stringify(entries[0]!.extra)).not.toContain('/some/internal/path');
    });
  });

  describe('HAPPY — tool_blocked extra is code-only', () => {
    it('formatRailResult extra contains code but not reason text', async () => {
      const { log, entries } = captureLogger();
      setAdapterLogger(log);
      const { formatRailResult } = await import('../../integration/tools/helpers.js');

      formatRailResult({
        kind: 'blocked',
        code: 'FOUR_EYES_ACTOR_MATCH',
        reason: 'approval denied: actor initiator-1 tried to approve own plan',
      });

      expect(entries[0]!.extra).toMatchObject({ code: 'FOUR_EYES_ACTOR_MATCH' });
      expect(JSON.stringify(entries[0]!.extra)).not.toContain('initiator-1');
      expect(JSON.stringify(entries[0]!.extra)).not.toContain('approve own plan');
    });

    it('overflowLimit is a number, not a message', async () => {
      const { log, entries } = captureLogger();
      setAdapterLogger(log);
      const { formatRailResult } = await import('../../integration/tools/helpers.js');

      formatRailResult({
        kind: 'blocked',
        code: 'AUTO_ADVANCE_OVERFLOW',
        reason: 'topology overflow with dangerous context /secret/token',
        overflow: { phase: 'PLAN', limit: 10 },
      });

      expect(entries[0]!.extra).toMatchObject({ code: 'AUTO_ADVANCE_OVERFLOW', overflowLimit: 10 });
      expect(JSON.stringify(entries[0]!.extra)).not.toContain('/secret/token');
      expect(typeof entries[0]!.extra!.overflowLimit).toBe('number');
    });
  });
});

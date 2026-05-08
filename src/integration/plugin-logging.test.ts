/**
 * @module integration/plugin-logging.test
 * @description Tests for FlowGuard plugin logging mode wiring.
 *
 * Tests that plugin.ts correctly wires sinks based on config mode:
 * - mode=file → file sink only
 * - mode=ui → UI sink only
 * - mode=both → both sinks
 * - mode=file without workspace → no sinks (noop)
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { buildLogSinks } from './plugin-logging.js';
import type { LogEntry, LogSink } from '../logging/logger.js';

const mockConfig = {
  logging: {
    mode: 'file' as const,
    level: 'info',
    retentionDays: 7,
  },
};

const mockClient = {
  app: {
    log: vi.fn().mockResolvedValue(undefined),
  },
};

const TEST_DIR = '/tmp/flowguard-wiring-test';

describe('buildLogSinks', () => {
  describe('HAPPY', () => {
    it('creates file sink when mode=file and workspace provided', () => {
      const config = { ...mockConfig, logging: { ...mockConfig.logging, mode: 'file' } };
      const sinks = buildLogSinks(config, undefined, TEST_DIR);

      expect(sinks).toHaveLength(1);
    });

    it('creates UI sink when mode=ui and client provided', () => {
      const config = { ...mockConfig, logging: { ...mockConfig.logging, mode: 'ui' } };
      const sinks = buildLogSinks(config, mockClient, null);

      expect(sinks).toHaveLength(1);
      expect(mockClient.app.log).not.toHaveBeenCalled();
    });

    it('creates both sinks when mode=both', () => {
      const config = { ...mockConfig, logging: { ...mockConfig.logging, mode: 'both' } };
      const sinks = buildLogSinks(config, mockClient, TEST_DIR);

      expect(sinks).toHaveLength(2);
    });

    it('returns file sink only for mode=file even with client', () => {
      const config = { ...mockConfig, logging: { ...mockConfig.logging, mode: 'file' } };
      const sinks = buildLogSinks(config, mockClient, TEST_DIR);

      expect(sinks).toHaveLength(1);
    });

    it('returns UI sink only for mode=ui even with workspace', () => {
      const config = { ...mockConfig, logging: { ...mockConfig.logging, mode: 'ui' } };
      const sinks = buildLogSinks(config, mockClient, TEST_DIR);

      expect(sinks).toHaveLength(1);
    });
  });

  describe('BAD', () => {
    it('returns empty array when mode=file but no workspace', () => {
      const config = { ...mockConfig, logging: { ...mockConfig.logging, mode: 'file' } };
      const sinks = buildLogSinks(config, undefined, null);

      expect(sinks).toHaveLength(0);
    });

    it('returns empty array when mode=ui but no client', () => {
      const config = { ...mockConfig, logging: { ...mockConfig.logging, mode: 'ui' } };
      const sinks = buildLogSinks(config, undefined, TEST_DIR);

      expect(sinks).toHaveLength(0);
    });

    it('returns empty array when mode=both but no workspace AND no client', () => {
      const config = { ...mockConfig, logging: { ...mockConfig.logging, mode: 'both' } };
      const sinks = buildLogSinks(config, undefined, null);

      expect(sinks).toHaveLength(0);
    });

    it('returns empty array when workspace is empty string', () => {
      const config = { ...mockConfig, logging: { ...mockConfig.logging, mode: 'file' } };
      const sinks = buildLogSinks(config, undefined, '');

      expect(sinks).toHaveLength(0);
    });

    it('handles relative workspace path without crashing', () => {
      const config = { ...mockConfig, logging: { ...mockConfig.logging, mode: 'file' } };
      const sinks = buildLogSinks(config, undefined, './relative');

      expect(sinks).toHaveLength(1);
    });
  });

  describe('CORNER', () => {
    it('handles mode as "both" with only workspace (no client)', () => {
      const config = { ...mockConfig, logging: { ...mockConfig.logging, mode: 'both' } };
      const sinks = buildLogSinks(config, undefined, TEST_DIR);

      expect(sinks).toHaveLength(1);
    });

    it('handles mode as "both" with only client (no workspace)', () => {
      const config = { ...mockConfig, logging: { ...mockConfig.logging, mode: 'both' } };
      const sinks = buildLogSinks(config, mockClient, null);

      expect(sinks).toHaveLength(1);
    });

    it('handles client without app.log', () => {
      const config = { ...mockConfig, logging: { ...mockConfig.logging, mode: 'ui' } };
      const clientNoLog = { app: {} };
      const sinks = buildLogSinks(config, clientNoLog as any, TEST_DIR);

      expect(sinks).toHaveLength(0);
    });

    it('handles retentionDays from config', () => {
      const config = {
        logging: { mode: 'file' as const, level: 'info', retentionDays: 30 },
      };
      const sinks = buildLogSinks(config, undefined, TEST_DIR);

      expect(sinks).toHaveLength(1);
    });
  });

  describe('EDGE', () => {
    it('handles all three mode values correctly', () => {
      const modes = ['file', 'ui', 'both'] as const;

      for (const mode of modes) {
        const config = { ...mockConfig, logging: { ...mockConfig.logging, mode } };
        const sinks = buildLogSinks(config, mockClient, TEST_DIR);
        expect(sinks.length).toBeGreaterThan(0);
      }
    });

    it('handles minimal config structure', () => {
      const config = { logging: { mode: 'file' as const, level: 'info', retentionDays: 7 } };
      const sinks = buildLogSinks(config, undefined, TEST_DIR);

      expect(sinks).toHaveLength(1);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// UI Sink Error Observability
// ═══════════════════════════════════════════════════════════════════════════════

describe('UI sink error observability', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  const uiConfig = { logging: { mode: 'ui' as const, level: 'info', retentionDays: 7 } };
  const testEntry: LogEntry = {
    level: 'info',
    service: 'test',
    message: 'hello',
  };

  // HAPPY: successful client.app.log produces no stderr output
  it('HAPPY — successful log does not write to stderr', async () => {
    const client = { app: { log: vi.fn().mockResolvedValue(undefined) } };
    const sinks = buildLogSinks(uiConfig, client, null);

    expect(sinks).toHaveLength(1);
    sinks[0](testEntry);

    // Allow microtask queue to flush (the .catch runs on next tick)
    await new Promise((r) => setTimeout(r, 10));

    expect(stderrSpy).not.toHaveBeenCalled();
    expect(client.app.log).toHaveBeenCalledWith({
      body: { service: 'test', level: 'info', message: 'hello' },
    });
  });

  // BAD: rejecting client.app.log emits warning to stderr
  it('BAD — rejecting log writes warning to stderr', async () => {
    const client = {
      app: { log: vi.fn().mockRejectedValue(new Error('connection lost')) },
    };
    const sinks = buildLogSinks(uiConfig, client, null);

    expect(sinks).toHaveLength(1);
    sinks[0](testEntry);

    await new Promise((r) => setTimeout(r, 10));

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const written = stderrSpy.mock.calls[0][0] as string;
    expect(written).toContain('[FlowGuard] UI log sink error');
    expect(written).toContain('connection lost');
    expect(written).toContain('1/3');
  });

  // CORNER: stderr warnings stop after the limit (3 failures)
  it('CORNER — suppresses stderr after 3 failures to prevent flooding', async () => {
    const client = {
      app: { log: vi.fn().mockRejectedValue(new Error('broken')) },
    };
    const sinks = buildLogSinks(uiConfig, client, null);
    const sink = sinks[0];

    // Fire 5 log calls — only first 3 should emit stderr
    for (let i = 0; i < 5; i++) {
      sink(testEntry);
    }

    await new Promise((r) => setTimeout(r, 50));

    expect(stderrSpy).toHaveBeenCalledTimes(3);
    // Verify the counter increments in the messages
    expect(stderrSpy.mock.calls[0][0] as string).toContain('1/3');
    expect(stderrSpy.mock.calls[1][0] as string).toContain('2/3');
    expect(stderrSpy.mock.calls[2][0] as string).toContain('3/3');
  });

  // EDGE: non-Error rejection (e.g. string) is still reported
  it('EDGE — non-Error rejection is reported via String()', async () => {
    const client = {
      app: { log: vi.fn().mockRejectedValue('raw string rejection') },
    };
    const sinks = buildLogSinks(uiConfig, client, null);

    sinks[0](testEntry);
    await new Promise((r) => setTimeout(r, 10));

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const written = stderrSpy.mock.calls[0][0] as string;
    expect(written).toContain('raw string rejection');
  });

  // EDGE: extra field in LogEntry is forwarded to client.app.log body
  it('EDGE — log entry with extra field includes it in the body', async () => {
    const client = { app: { log: vi.fn().mockResolvedValue(undefined) } };
    const sinks = buildLogSinks(uiConfig, client, null);

    const entryWithExtra: LogEntry = {
      level: 'warn',
      service: 'audit',
      message: 'integrity check',
      extra: { chain: 'ok', duration: 42 },
    };
    sinks[0](entryWithExtra);
    await new Promise((r) => setTimeout(r, 10));

    expect(client.app.log).toHaveBeenCalledWith({
      body: {
        service: 'audit',
        level: 'warn',
        message: 'integrity check',
        extra: { chain: 'ok', duration: 42 },
      },
    });
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  // EDGE: independent sink instances have independent failure counters
  it('EDGE — separate buildLogSinks calls get independent failure counters', async () => {
    const client1 = {
      app: { log: vi.fn().mockRejectedValue(new Error('fail-1')) },
    };
    const client2 = {
      app: { log: vi.fn().mockRejectedValue(new Error('fail-2')) },
    };

    const sinks1 = buildLogSinks(uiConfig, client1, null);
    const sinks2 = buildLogSinks(uiConfig, client2, null);

    // 4 failures on sink1 (only 3 reported) + 1 failure on sink2
    for (let i = 0; i < 4; i++) sinks1[0](testEntry);
    sinks2[0](testEntry);

    await new Promise((r) => setTimeout(r, 50));

    // sink1: 3 warnings + sink2: 1 warning = 4 total
    expect(stderrSpy).toHaveBeenCalledTimes(4);
    // sink2's warning should reference its own counter (1/3, not 4/3)
    const lastCall = stderrSpy.mock.calls[3][0] as string;
    expect(lastCall).toContain('1/3');
    expect(lastCall).toContain('fail-2');
  });
});

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
import { buildLogSinks, addOtlpSinkIfEnabled } from './plugin-logging.js';
import type { LogEntry, LogSink } from '../logging/logger.js';
import type { OtlpSinkHandle } from '../logging/otlp-sink.js';
import type { FlowGuardConfig } from '../config/flowguard-config.js';

type TestLoggingConfig = Pick<
  FlowGuardConfig['logging'],
  'mode' | 'level' | 'retentionDays' | 'consoleFormat' | 'maxFileSizeMb' | 'otlp'
>;

function loggingConfig(overrides: Partial<TestLoggingConfig> = {}): TestLoggingConfig {
  return {
    mode: 'file',
    level: 'info',
    retentionDays: 7,
    consoleFormat: 'text',
    maxFileSizeMb: 10,
    otlp: { enabled: false },
    ...overrides,
  };
}

const mockClient = {
  app: {
    log: vi.fn().mockResolvedValue(undefined),
  },
};

const TEST_DIR = '/tmp/flowguard-wiring-test';

describe('buildLogSinks', () => {
  describe('HAPPY', () => {
    it('creates file sink when mode=file and workspace provided', () => {
      const config = { logging: loggingConfig({ mode: 'file' }) };
      const { sinks } = buildLogSinks(config, undefined, TEST_DIR);

      expect(sinks).toHaveLength(1);
    });

    it('creates UI sink when mode=ui and client provided', () => {
      const config = { logging: loggingConfig({ mode: 'ui' }) };
      const { sinks } = buildLogSinks(config, mockClient, null);

      expect(sinks).toHaveLength(1);
      expect(mockClient.app.log).not.toHaveBeenCalled();
    });

    it('creates both sinks when mode=both', () => {
      const config = { logging: loggingConfig({ mode: 'both' }) };
      const { sinks } = buildLogSinks(config, mockClient, TEST_DIR);

      expect(sinks).toHaveLength(2);
    });

    it('returns file sink only for mode=file even with client', () => {
      const config = { logging: loggingConfig({ mode: 'file' }) };
      const { sinks } = buildLogSinks(config, mockClient, TEST_DIR);

      expect(sinks).toHaveLength(1);
    });

    it('returns UI sink only for mode=ui even with workspace', () => {
      const config = { logging: loggingConfig({ mode: 'ui' }) };
      const { sinks } = buildLogSinks(config, mockClient, TEST_DIR);

      expect(sinks).toHaveLength(1);
    });
  });

  describe('BAD', () => {
    it('returns empty array when mode=file but no workspace', () => {
      const config = { logging: loggingConfig({ mode: 'file' }) };
      const { sinks } = buildLogSinks(config, undefined, null);

      expect(sinks).toHaveLength(0);
    });

    it('returns empty array when mode=ui but no client', () => {
      const config = { logging: loggingConfig({ mode: 'ui' }) };
      const { sinks } = buildLogSinks(config, undefined, TEST_DIR);

      expect(sinks).toHaveLength(0);
    });

    it('returns empty array when mode=both but no workspace AND no client', () => {
      const config = { logging: loggingConfig({ mode: 'both' }) };
      const { sinks } = buildLogSinks(config, undefined, null);

      expect(sinks).toHaveLength(0);
    });

    it('returns empty array when workspace is empty string', () => {
      const config = { logging: loggingConfig({ mode: 'file' }) };
      const { sinks } = buildLogSinks(config, undefined, '');

      expect(sinks).toHaveLength(0);
    });

    it('handles relative workspace path without crashing', () => {
      const config = { logging: loggingConfig({ mode: 'file' }) };
      const { sinks } = buildLogSinks(config, undefined, './relative');

      expect(sinks).toHaveLength(1);
    });
  });

  describe('CORNER', () => {
    it('handles mode as "both" with only workspace (no client)', () => {
      const config = { logging: loggingConfig({ mode: 'both' }) };
      const { sinks } = buildLogSinks(config, undefined, TEST_DIR);

      expect(sinks).toHaveLength(1);
    });

    it('handles mode as "both" with only client (no workspace)', () => {
      const config = { logging: loggingConfig({ mode: 'both' }) };
      const { sinks } = buildLogSinks(config, mockClient, null);

      expect(sinks).toHaveLength(1);
    });

    it('handles client without app.log', () => {
      const config = { logging: loggingConfig({ mode: 'ui' }) };
      const clientNoLog = { app: {} };
      const { sinks } = buildLogSinks(config, clientNoLog as any, TEST_DIR);

      expect(sinks).toHaveLength(0);
    });

    it('handles retentionDays from config', () => {
      const config = {
        logging: loggingConfig({ mode: 'file', retentionDays: 30 }),
      };
      const { sinks } = buildLogSinks(config, undefined, TEST_DIR);

      expect(sinks).toHaveLength(1);
    });
  });

  describe('EDGE', () => {
    it('handles all three mode values correctly', () => {
      const modes = ['file', 'ui', 'both'] as const;

      for (const mode of modes) {
        const config = { logging: loggingConfig({ mode }) };
        const { sinks } = buildLogSinks(config, mockClient, TEST_DIR);
        expect(sinks.length).toBeGreaterThan(0);
      }
    });

    it('handles minimal config structure', () => {
      const config = { logging: loggingConfig({ mode: 'file' }) };
      const { sinks } = buildLogSinks(config, undefined, TEST_DIR);

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

  const uiConfig = { logging: loggingConfig({ mode: 'ui' }) };
  const testEntry: LogEntry = {
    level: 'info',
    service: 'test',
    message: 'hello',
  };

  // HAPPY: successful client.app.log produces no stderr output
  it('HAPPY — successful log does not write to stderr', async () => {
    const client = { app: { log: vi.fn().mockResolvedValue(undefined) } };
    const { sinks } = buildLogSinks(uiConfig, client, null);

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
    const { sinks } = buildLogSinks(uiConfig, client, null);

    expect(sinks).toHaveLength(1);
    await expect(sinks[0](testEntry)).rejects.toThrow('UI log sink failure');

    await new Promise((r) => setTimeout(r, 10));

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const written = stderrSpy.mock.calls[0][0] as string;
    expect(written).toContain('[FlowGuard] UI log sink failure');
    expect(written).toContain('(1 total)');
  });

  // CORNER: stderr warnings stop after the limit (3 failures) per 5-min window
  it('CORNER — suppresses stderr after 3 failures to prevent flooding', async () => {
    const client = {
      app: { log: vi.fn().mockRejectedValue(new Error('broken')) },
    };
    const { sinks } = buildLogSinks(uiConfig, client, null);
    const sink = sinks[0];

    // Fire 5 log calls — only first 3 should emit stderr (5-min window)
    for (let i = 0; i < 5; i++) {
      await expect(sink(testEntry)).rejects.toThrow('UI log sink failure');
    }

    await new Promise((r) => setTimeout(r, 50));

    expect(stderrSpy).toHaveBeenCalledTimes(3);
    expect(stderrSpy.mock.calls[0][0] as string).toContain('(1 total)');
    expect(stderrSpy.mock.calls[1][0] as string).toContain('(2 total)');
    expect(stderrSpy.mock.calls[2][0] as string).toContain('(3 total)');
  });

  // EDGE: non-Error rejection (e.g. string) is still reported
  it('EDGE — non-Error rejection is reported via stderr', async () => {
    const client = {
      app: { log: vi.fn().mockRejectedValue('raw string rejection') },
    };
    const { sinks } = buildLogSinks(uiConfig, client, null);

    await expect(sinks[0](testEntry)).rejects.toThrow('UI log sink failure');
    await new Promise((r) => setTimeout(r, 10));

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const written = stderrSpy.mock.calls[0][0] as string;
    expect(written).toContain('[FlowGuard] UI log sink failure');
    expect(written).toContain('(1 total)');
  });

  // EDGE: extra field in LogEntry is forwarded to client.app.log body
  it('EDGE — log entry with extra field includes it in the body', async () => {
    const client = { app: { log: vi.fn().mockResolvedValue(undefined) } };
    const { sinks } = buildLogSinks(uiConfig, client, null);

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

    const { sinks: sinks1 } = buildLogSinks(uiConfig, client1, null);
    const { sinks: sinks2 } = buildLogSinks(uiConfig, client2, null);

    // 4 failures on sink1 (only 3 reported within 5-min window) + 1 failure on sink2
    for (let i = 0; i < 4; i++)
      await expect(sinks1[0](testEntry)).rejects.toThrow('UI log sink failure');
    await expect(sinks2[0](testEntry)).rejects.toThrow('UI log sink failure');

    await new Promise((r) => setTimeout(r, 50));

    // sink1: 3 warnings + sink2: 1 warning = 4 total
    expect(stderrSpy).toHaveBeenCalledTimes(4);
    // sink2's warning should reference its own counter (1 total, not 4 total)
    const lastCall = stderrSpy.mock.calls[3][0] as string;
    expect(lastCall).toContain('(1 total)');
  });

  // G10: UI sink rejection is centrally counted via createLogger's sinkFailuresTotal
  it('G10 — UI sink rejection increments central sinkFailuresTotal', async () => {
    const client = {
      app: { log: vi.fn().mockRejectedValue(new Error('ui failure')) },
    };
    const { sinks } = buildLogSinks(uiConfig, client, null);
    expect(sinks).toHaveLength(1);

    // Wrap the UI sink in a logger so createLogger counts rejections
    const { createLogger } = await import('../logging/logger.js');
    const log = createLogger('debug', sinks);

    // Cause a UI sink failure
    log.info('test', 'message');

    // Wait for async rejection to be counted
    await new Promise((r) => setTimeout(r, 50));

    const health = (log as import('../logging/logger.js').HealthAwareLogger).getHealth();
    expect(health.sinkFailuresTotal).toBeGreaterThanOrEqual(1);
  });
});

describe('addOtlpSinkIfEnabled (egress gating)', () => {
  const ORIGINAL_ENV = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = ORIGINAL_ENV;
    vi.restoreAllMocks();
  });

  function run(otlp: { enabled: boolean; endpoint?: string; allowInsecure?: boolean }): {
    sinks: LogSink[];
    disposables: OtlpSinkHandle[];
  } {
    const sinks: LogSink[] = [];
    const disposables: OtlpSinkHandle[] = [];
    addOtlpSinkIfEnabled({ logging: { otlp } }, sinks, disposables);
    return { sinks, disposables };
  }

  it('disabled: adds no sink and no disposable', () => {
    const { sinks, disposables } = run({ enabled: false });
    expect(sinks).toHaveLength(0);
    expect(disposables).toHaveLength(0);
  });

  it('enabled with https endpoint: adds a sink and a disposable', () => {
    const { sinks, disposables } = run({ enabled: true, endpoint: 'https://collector:4318' });
    expect(sinks).toHaveLength(1);
    expect(disposables).toHaveLength(1);
  });

  it('enabled without endpoint and no env var: warns and adds nothing', () => {
    const { sinks } = run({ enabled: true });
    expect(sinks).toHaveLength(0);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('no endpoint configured'));
  });

  it('enabled with malformed endpoint: warns and adds nothing', () => {
    const { sinks } = run({ enabled: true, endpoint: 'not a url at all' });
    expect(sinks).toHaveLength(0);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('not a valid URL'));
  });

  it('enabled with a non-http scheme: warns and adds nothing', () => {
    const { sinks } = run({ enabled: true, endpoint: 'collector:4318' });
    expect(sinks).toHaveLength(0);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('http(s) URL'));
  });

  it('enabled with http endpoint and no allowInsecure: warns and adds nothing', () => {
    const { sinks } = run({ enabled: true, endpoint: 'http://collector:4318' });
    expect(sinks).toHaveLength(0);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('must use https://'));
  });

  it('enabled with http endpoint and allowInsecure: adds the sink', () => {
    const { sinks } = run({
      enabled: true,
      endpoint: 'http://collector:4318',
      allowInsecure: true,
    });
    expect(sinks).toHaveLength(1);
  });

  it('uses OTEL_EXPORTER_OTLP_ENDPOINT env fallback (validated)', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://env-collector:4318';
    const { sinks } = run({ enabled: true });
    expect(sinks).toHaveLength(1);
  });

  it('rejects a cleartext env fallback endpoint without allowInsecure', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://env-collector:4318';
    const { sinks } = run({ enabled: true });
    expect(sinks).toHaveLength(0);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('must use https://'));
  });
});

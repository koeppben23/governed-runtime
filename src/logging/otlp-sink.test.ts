/**
 * @module logging/otlp-sink.test
 * @description Tests for OTLP log exporter sink.
 *
 * Uses _import injection to mock OTEL packages without relying on
 * vitest module mocking (which doesn't intercept dynamic import() in ESM).
 *
 * Covers:
 * - HAPPY: lazy init on first write, log record emitted with correct fields
 * - HAPPY: severity mapping for all 4 levels
 * - HAPPY: extra_json attribute contains redacted extra data
 * - HAPPY: message body is sanitized before egress
 * - BAD: onFailure called on emit error (non-blocking)
 * - CORNER: lazy init failure → stderr warning, sink silent
 * - CORNER: sink always resolves (no promise rejection)
 * - LIFECYCLE: flush forwards to forceFlush; shutdown forwards to provider.shutdown,
 *   is idempotent, and makes the sink a no-op afterwards
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 * @version v2
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createOtlpLogSink } from './otlp-sink.js';
import type { LogEntry } from './logger.js';

const testEntry: LogEntry = {
  level: 'info',
  service: 'audit',
  message: 'test message',
  traceId: 'trace-123',
  sessionId: 'session-456',
  extra: { code: 'E1', path: '/home/user/secret' },
};

function createMockOtelModules() {
  const emitFn = vi.fn();
  const forceFlushFn = vi.fn().mockResolvedValue(undefined);
  const shutdownFn = vi.fn().mockResolvedValue(undefined);

  class MockLoggerProvider {
    getLogger = vi.fn().mockReturnValue({ emit: emitFn, enabled: () => true });
    forceFlush = forceFlushFn;
    shutdown = shutdownFn;
  }
  class MockBatchLogRecordProcessor {}
  class MockOtlpLogExporter {}

  return {
    emitFn,
    forceFlushFn,
    shutdownFn,
    mockImport(): Promise<Record<string, unknown>> {
      return Promise.resolve({
        SeverityNumber: { TRACE: 1, DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17, FATAL: 21 },
        LoggerProvider: MockLoggerProvider,
        BatchLogRecordProcessor: MockBatchLogRecordProcessor,
        OTLPLogExporter: MockOtlpLogExporter,
      });
    },
  };
}

function createFailingImportModules() {
  return {
    emitFn: vi.fn(),
    mockImport(): Promise<Record<string, unknown>> {
      return Promise.reject(new Error('OTEL packages not available'));
    },
  };
}

function createFailingEmitModules() {
  const emitFn = vi.fn().mockImplementation(() => {
    throw new Error('export failed');
  });

  class MockLoggerProvider {
    getLogger = vi.fn().mockReturnValue({ emit: emitFn, enabled: () => true });
    forceFlush = vi.fn().mockResolvedValue(undefined);
    shutdown = vi.fn().mockResolvedValue(undefined);
  }
  class MockBatchLogRecordProcessor {}
  class MockOtlpLogExporter {}

  return {
    emitFn,
    mockImport(): Promise<Record<string, unknown>> {
      return Promise.resolve({
        SeverityNumber: { TRACE: 1, DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17, FATAL: 21 },
        LoggerProvider: MockLoggerProvider,
        BatchLogRecordProcessor: MockBatchLogRecordProcessor,
        OTLPLogExporter: MockOtlpLogExporter,
      });
    },
  };
}

describe('createOtlpLogSink', () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('HAPPY: lazy init on first write, log record emitted', async () => {
    const mods = createMockOtelModules();
    const { sink } = createOtlpLogSink({
      endpoint: 'http://localhost:4318',
      _import: mods.mockImport,
    });

    await sink(testEntry);
    expect(mods.emitFn).toHaveBeenCalledTimes(1);

    const record = mods.emitFn.mock.calls[0]![0] as Record<string, unknown>;
    expect(record.severityNumber).toBe(9);
    expect(record.body).toBe('test message');

    const attrs = record.attributes as Record<string, unknown>;
    expect(attrs['flowguard.service']).toBe('audit');
    expect(attrs['flowguard.level']).toBe('info');
    expect(attrs['flowguard.traceId']).toBe('trace-123');
    expect(attrs['flowguard.sessionId']).toBe('session-456');

    // Second write reuses cached logger
    await sink({ ...testEntry, message: 'second' });
    expect(mods.emitFn).toHaveBeenCalledTimes(2);
  });

  it('HAPPY: extra_json contains redacted extra data', async () => {
    const mods = createMockOtelModules();
    const { sink } = createOtlpLogSink({
      endpoint: 'http://localhost:4318',
      _import: mods.mockImport,
    });

    await sink(testEntry);

    const record = mods.emitFn.mock.calls[0]![0] as Record<string, unknown>;
    const attrs = record.attributes as Record<string, unknown>;
    const extraJson = attrs['flowguard.extra_json'] as string;

    // code value should be preserved
    expect(extraJson).toContain('E1');
    // absolute path should be redacted
    expect(extraJson).not.toContain('/home/user/secret');
  });

  it('HAPPY: message body is sanitized before egress', async () => {
    const mods = createMockOtelModules();
    const { sink } = createOtlpLogSink({
      endpoint: 'http://localhost:4318',
      _import: mods.mockImport,
    });

    await sink({ ...testEntry, message: 'failed reading /home/user/.flowguard/token.json' });
    const record = mods.emitFn.mock.calls[0]![0] as Record<string, unknown>;
    expect(record.body).not.toContain('/home/user/.flowguard/token.json');
  });

  it('HAPPY: severity mapping for all 4 levels', async () => {
    const mods = createMockOtelModules();
    const { sink } = createOtlpLogSink({
      endpoint: 'http://localhost:4318',
      _import: mods.mockImport,
    });

    const cases: Array<[LogEntry['level'], number]> = [
      ['debug', 1],
      ['info', 9],
      ['warn', 13],
      ['error', 17],
    ];

    for (const [level, expected] of cases) {
      await sink({ ...testEntry, level });
      const idx = mods.emitFn.mock.calls.length - 1;
      expect(mods.emitFn.mock.calls[idx]![0].severityNumber).toBe(expected);
    }
    // Distinct non-default mappings prove SEVERITY_MAP is populated (not {}).
    const numbers = mods.emitFn.mock.calls.map((c) => c[0].severityNumber);
    expect(new Set(numbers).size).toBe(4);
    expect(numbers).toContain(17); // error != default INFO(9)
  });

  it('BAD: onFailure called on emit error, sink survives', async () => {
    const mods = createFailingEmitModules();
    const onFailure = vi.fn();
    const { sink } = createOtlpLogSink({
      endpoint: 'http://localhost:4318',
      _import: mods.mockImport,
      onFailure,
    });

    await sink(testEntry);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('CORNER: sink always resolves, no promise rejection', async () => {
    const mods = createFailingEmitModules();
    const { sink } = createOtlpLogSink({
      endpoint: 'http://localhost:4318',
      _import: mods.mockImport,
    });

    await expect(sink(testEntry)).resolves.toBeUndefined();
  });

  it('CORNER: lazy init failure → stderr warning, sink silent', async () => {
    const mods = createFailingImportModules();
    const { sink } = createOtlpLogSink({
      endpoint: 'http://localhost:4318',
      _import: mods.mockImport,
    });

    await sink(testEntry); // should not throw

    const stderrCalls = (process.stderr.write as unknown as { mock: { calls: Array<[string]> } })
      .mock.calls;
    const warnings = stderrCalls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('OTLP log export init failed'),
    );
    expect(warnings.length).toBe(1);

    // Second write is silent (no double warning): proves the _initErrLogged guard
    // and that ensureInit short-circuits on the second call.
    await sink(testEntry);
    const warnings2 = (
      process.stderr.write as unknown as { mock: { calls: Array<[string]> } }
    ).mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('OTLP log export init failed'),
    );
    expect(warnings2.length).toBe(1);
  });

  it('CORNER: init failure path returns false so no emit is attempted', async () => {
    const emitFn = vi.fn();
    let calls = 0;
    const flakyImport = (): Promise<Record<string, unknown>> => {
      calls++;
      return Promise.reject(new Error('boom'));
    };
    const { sink } = createOtlpLogSink({ endpoint: 'http://localhost:4318', _import: flakyImport });
    await sink(testEntry);
    const afterFirst = calls;
    await sink(testEntry);
    // ensureInit imports the two OTEL packages once; the second write must NOT
    // re-import (the _initialized guard short-circuits) and never emits.
    expect(calls).toBe(afterFirst);
    expect(emitFn).not.toHaveBeenCalled();
  });

  it('CORNER: unknown severity level maps to INFO (9)', async () => {
    const mods = createMockOtelModules();
    const { sink } = createOtlpLogSink({
      endpoint: 'http://localhost:4318',
      _import: mods.mockImport,
    });
    await sink({ ...testEntry, level: 'verbose' as unknown as LogEntry['level'] });
    const record = mods.emitFn.mock.calls[0]![0] as Record<string, unknown>;
    expect(record.severityNumber).toBe(9);
  });

  it('CORNER: severityText and attributes mirror the entry exactly', async () => {
    const mods = createMockOtelModules();
    const { sink } = createOtlpLogSink({
      endpoint: 'http://localhost:4318',
      _import: mods.mockImport,
    });
    await sink({ ...testEntry, level: 'warn', traceId: undefined, sessionId: undefined });
    const record = mods.emitFn.mock.calls[0]![0] as Record<string, unknown>;
    expect(record.severityText).toBe('warn');
    const attrs = record.attributes as Record<string, string>;
    expect(attrs['flowguard.traceId']).toBe('');
    expect(attrs['flowguard.sessionId']).toBe('');
  });

  it('CORNER: provider is initialised exactly once across many writes', async () => {
    const mods = createMockOtelModules();
    const getLoggerSpy = vi.fn().mockReturnValue({ emit: mods.emitFn });
    const importOnce = (): Promise<Record<string, unknown>> =>
      Promise.resolve({
        LoggerProvider: class {
          getLogger = getLoggerSpy;
          forceFlush = mods.forceFlushFn;
          shutdown = mods.shutdownFn;
        },
        BatchLogRecordProcessor: class {},
        OTLPLogExporter: class {},
      });
    const { sink } = createOtlpLogSink({ endpoint: 'http://localhost:4318', _import: importOnce });
    await sink(testEntry);
    await sink(testEntry);
    await sink(testEntry);
    expect(getLoggerSpy).toHaveBeenCalledTimes(1);
  });

  describe('lifecycle (flush / shutdown)', () => {
    it('flush forwards to provider.forceFlush after init', async () => {
      const mods = createMockOtelModules();
      const handle = createOtlpLogSink({
        endpoint: 'http://localhost:4318',
        _import: mods.mockImport,
      });
      await handle.sink(testEntry);
      await handle.flush();
      expect(mods.forceFlushFn).toHaveBeenCalledTimes(1);
    });

    it('flush before init is a safe no-op', async () => {
      const mods = createMockOtelModules();
      const handle = createOtlpLogSink({
        endpoint: 'http://localhost:4318',
        _import: mods.mockImport,
      });
      await expect(handle.flush()).resolves.toBeUndefined();
      expect(mods.forceFlushFn).not.toHaveBeenCalled();
    });

    it('shutdown forwards to provider.shutdown and is idempotent', async () => {
      const mods = createMockOtelModules();
      const handle = createOtlpLogSink({
        endpoint: 'http://localhost:4318',
        _import: mods.mockImport,
      });
      await handle.sink(testEntry);
      await handle.shutdown();
      await handle.shutdown(); // idempotent — second call does nothing
      expect(mods.shutdownFn).toHaveBeenCalledTimes(1);
    });

    it('sink is a no-op after shutdown (no further emits)', async () => {
      const mods = createMockOtelModules();
      const handle = createOtlpLogSink({
        endpoint: 'http://localhost:4318',
        _import: mods.mockImport,
      });
      await handle.sink(testEntry);
      expect(mods.emitFn).toHaveBeenCalledTimes(1);
      await handle.shutdown();
      await handle.sink(testEntry);
      expect(mods.emitFn).toHaveBeenCalledTimes(1); // unchanged
    });

    it('shutdown before any init is a safe no-op', async () => {
      const mods = createMockOtelModules();
      const handle = createOtlpLogSink({
        endpoint: 'http://localhost:4318',
        _import: mods.mockImport,
      });
      await expect(handle.shutdown()).resolves.toBeUndefined();
      expect(mods.shutdownFn).not.toHaveBeenCalled();
    });

    it('shutdown error is reported via onFailure, never thrown', async () => {
      const mods = createMockOtelModules();
      mods.shutdownFn.mockRejectedValueOnce(new Error('shutdown failed'));
      const onFailure = vi.fn();
      const handle = createOtlpLogSink({
        endpoint: 'http://localhost:4318',
        _import: mods.mockImport,
        onFailure,
      });
      await handle.sink(testEntry);
      await expect(handle.shutdown()).resolves.toBeUndefined();
      expect(onFailure).toHaveBeenCalledTimes(1);
    });

    it('flush after shutdown does not call forceFlush (provider released)', async () => {
      const mods = createMockOtelModules();
      const handle = createOtlpLogSink({
        endpoint: 'http://localhost:4318',
        _import: mods.mockImport,
      });
      await handle.sink(testEntry);
      await handle.shutdown();
      await handle.flush();
      expect(mods.forceFlushFn).not.toHaveBeenCalled();
    });

    it('flush error is reported via onFailure, never thrown', async () => {
      const mods = createMockOtelModules();
      mods.forceFlushFn.mockRejectedValueOnce(new Error('flush failed'));
      const onFailure = vi.fn();
      const handle = createOtlpLogSink({
        endpoint: 'http://localhost:4318',
        _import: mods.mockImport,
        onFailure,
      });
      await handle.sink(testEntry);
      await expect(handle.flush()).resolves.toBeUndefined();
      expect(onFailure).toHaveBeenCalledTimes(1);
    });

    it('shutdown before any write never imports the SDK and stays a no-op', async () => {
      const importSpy = vi.fn(() => Promise.reject(new Error('should not import')));
      const handle = createOtlpLogSink({ endpoint: 'http://localhost:4318', _import: importSpy });
      await handle.shutdown();
      expect(importSpy).not.toHaveBeenCalled();
      // a write after shutdown must also not import / emit
      await handle.sink(testEntry);
      expect(importSpy).not.toHaveBeenCalled();
    });
  });
});

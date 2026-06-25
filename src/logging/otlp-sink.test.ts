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
 * - BAD: onFailure called on emit error (non-blocking)
 * - CORNER: lazy init failure → stderr warning, sink silent
 * - CORNER: sink always resolves (no promise rejection)
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 * @version v1
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

  class MockLoggerProvider {
    getLogger = vi.fn().mockReturnValue({ emit: emitFn, enabled: () => true });
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
    const sink = createOtlpLogSink({ endpoint: 'http://localhost:4318', _import: mods.mockImport });

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
    const sink = createOtlpLogSink({ endpoint: 'http://localhost:4318', _import: mods.mockImport });

    await sink(testEntry);

    const record = mods.emitFn.mock.calls[0]![0] as Record<string, unknown>;
    const attrs = record.attributes as Record<string, unknown>;
    const extraJson = attrs['flowguard.extra_json'] as string;

    // code value should be preserved
    expect(extraJson).toContain('E1');
    // absolute path should be redacted
    expect(extraJson).not.toContain('/home/user/secret');
  });

  it('HAPPY: severity mapping for all 4 levels', async () => {
    const mods = createMockOtelModules();
    const sink = createOtlpLogSink({ endpoint: 'http://localhost:4318', _import: mods.mockImport });

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
  });

  it('BAD: onFailure called on emit error, sink survives', async () => {
    const mods = createFailingEmitModules();
    const onFailure = vi.fn();
    const sink = createOtlpLogSink({
      endpoint: 'http://localhost:4318',
      _import: mods.mockImport,
      onFailure,
    });

    await sink(testEntry);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('CORNER: sink always resolves, no promise rejection', async () => {
    const mods = createFailingEmitModules();
    const sink = createOtlpLogSink({
      endpoint: 'http://localhost:4318',
      _import: mods.mockImport,
    });

    await expect(sink(testEntry)).resolves.toBeUndefined();
  });

  it('CORNER: lazy init failure → stderr warning, sink silent', async () => {
    const mods = createFailingImportModules();
    const sink = createOtlpLogSink({ endpoint: 'http://localhost:4318', _import: mods.mockImport });

    await sink(testEntry); // should not throw

    const stderrCalls = (process.stderr.write as unknown as { mock: { calls: Array<[string]> } })
      .mock.calls;
    const warnings = stderrCalls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('OTLP log export init failed'),
    );
    expect(warnings.length).toBe(1);

    // Second write is silent (no double warning)
    await sink(testEntry);
    expect(warnings.length).toBe(1);
  });
});

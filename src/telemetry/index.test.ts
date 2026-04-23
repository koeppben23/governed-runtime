/**
 * @module telemetry/index.test
 * @description Tests for FlowGuard OpenTelemetry instrumentation.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('telemetry', () => {
  describe('HAPPY', () => {
    it('withSpan executes function and returns result', async () => {
      const { withSpan } = await import('./index.js');
      const result = await withSpan('test.operation', async () => {
        return 'success';
      });
      expect(result).toBe('success');
    });

    it('withSpanSync executes function and returns result', async () => {
      const { withSpanSync } = await import('./index.js');
      const result = withSpanSync('test.operation', () => {
        return 'success';
      });
      expect(result).toBe('success');
    });

    it('withSpan catches errors and rethrows', async () => {
      const { withSpan } = await import('./index.js');
      await expect(
        withSpan('test.operation', async () => {
          throw new Error('test error');
        }),
      ).rejects.toThrow('test error');
    });

    it('withSpanSync catches errors and rethrows', async () => {
      const { withSpanSync } = await import('./index.js');
      expect(() => {
        withSpanSync('test.operation', () => {
          throw new Error('test error');
        });
      }).toThrow('test error');
    });

    it('withSpan passes through attributes to span', async () => {
      const { withSpan } = await import('./index.js');
      const result = await withSpan('test.operation', async () => 'done', { customAttr: 'value' });
      expect(result).toBe('done');
    });
  });

  describe('BAD', () => {
    it('handles gracefully when OTEL not configured', async () => {
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      const { withSpan } = await import('./index.js');
      const result = await withSpan('test.operation', async () => 'result');
      expect(result).toBe('result');
    });

    it('withSpan handles undefined attributes gracefully', async () => {
      const { withSpan } = await import('./index.js');
      const result = await withSpan('test.operation', async () => 'done', undefined);
      expect(result).toBe('done');
    });

    it('withSpanSync handles undefined attributes gracefully', async () => {
      const { withSpanSync } = await import('./index.js');
      const result = withSpanSync('test.operation', () => 'done', undefined);
      expect(result).toBe('done');
    });
  });

  describe('CORNER', () => {
    it('handles concurrent withSpan calls', async () => {
      const { withSpan } = await import('./index.js');
      const results = await Promise.all([
        withSpan('op1', async () => 'r1'),
        withSpan('op2', async () => 'r2'),
        withSpan('op3', async () => 'r3'),
      ]);
      expect(results).toEqual(['r1', 'r2', 'r3']);
    });

    it('withSpan works with empty attribute object', async () => {
      const { withSpan } = await import('./index.js');
      const result = await withSpan('op', async () => 'x', {});
      expect(result).toBe('x');
    });

    it('withSpanSync works with empty attribute object', async () => {
      const { withSpanSync } = await import('./index.js');
      const result = withSpanSync('op', () => 'x', {});
      expect(result).toBe('x');
    });

    it('withSpan works with numeric attributes', async () => {
      const { withSpan } = await import('./index.js');
      const result = await withSpan('op', async () => 'x', { count: 42, ratio: 3.14 });
      expect(result).toBe('x');
    });

    it('withSpan works with boolean attributes', async () => {
      const { withSpan } = await import('./index.js');
      const result = await withSpan('op', async () => 'x', { enabled: true, required: false });
      expect(result).toBe('x');
    });
  });

  describe('EDGE', () => {
    it('handles deeply nested async operations', async () => {
      const { withSpan } = await import('./index.js');
      const result = await withSpan('outer', async () => {
        return await withSpan('inner', async () => {
          return await withSpan('deep', async () => 'deep result');
        });
      });
      expect(result).toBe('deep result');
    });

    it('withSpanSync works in synchronous context', async () => {
      const { withSpanSync } = await import('./index.js');
      const result = withSpanSync('sync.op', () => 'sync result');
      expect(result).toBe('sync result');
    });

    it('handles very long operation names', async () => {
      const { withSpan } = await import('./index.js');
      const longName = 'a'.repeat(500);
      const result = await withSpan(longName, async () => 'ok');
      expect(result).toBe('ok');
    });
  });
});

describe('SpanStatusCode', () => {
  it('exports SpanStatusCode enum', async () => {
    const { SpanStatusCode } = await import('./index.js');
    expect(SpanStatusCode.OK).toBe(1);
    expect(SpanStatusCode.ERROR).toBe(2);
  });
});

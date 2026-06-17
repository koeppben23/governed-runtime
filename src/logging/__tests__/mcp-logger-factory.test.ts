/**
 * @module logging/__tests__/mcp-logger-factory
 * @description Contract tests for the MCP logger factory.
 *
 * The MCP server uses a standalone logger (no plugin ALS scope).
 * The factory must produce a FlowGuardLogger-compatible instance that
 * never crashes on write (noop-safe when no console sink writes).
 *
 * @test-policy HAPPY, CORNER — mcpLogger is diagnostic only.
 */

import { describe, it, expect } from 'vitest';
import { createLogger, createNoopLogger, type FlowGuardLogger } from '../logger.js';
import { createConsoleSink } from '../console-sink.js';

describe('mcp-logger-factory', () => {
  describe('HAPPY — factory produces FlowGuardLogger-compatible instance', () => {
    it('createLogger with console sink returns logger with all four levels', () => {
      const logger = createLogger('info', [createConsoleSink()]);
      expect(typeof logger.debug).toBe('function');
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
    });

    it('info-level calls do not throw for any level', () => {
      const logger = createLogger('info', [createConsoleSink()]);
      expect(() => logger.debug('mcp', 'debug message')).not.toThrow();
      expect(() => logger.info('mcp', 'server_created', { version: '1.0.0' })).not.toThrow();
      expect(() => logger.warn('mcp', 'tool_denied', { code: 'TEST' })).not.toThrow();
      expect(() => logger.error('mcp', 'transport_error', { errorName: 'TestError' })).not.toThrow();
    });
  });

  describe('CORNER — without sinks behaves as noop', () => {
    it('createLogger without sinks does not crash on any call', () => {
      const logger = createLogger('info');
      expect(() => logger.error('mcp', 'critical', { detail: 'test' })).not.toThrow();
    });

    it('createNoopLogger does not crash on any call', () => {
      const logger = createNoopLogger();
      expect(() => logger.error('mcp', 'critical', { detail: 'test' })).not.toThrow();
    });
  });

  describe('CORNER — mcpLogger module is importable', () => {
    it('mcpLogger exports a FlowGuardLogger instance', async () => {
      // Dynamic import to avoid side effects in the test context.
      const { mcpLogger } = await import('../../mcp-server/mcp-logger.js');
      expect(typeof mcpLogger.info).toBe('function');
      expect(typeof mcpLogger.warn).toBe('function');
      expect(typeof mcpLogger.error).toBe('function');
      expect(typeof mcpLogger.debug).toBe('function');
    });
  });
});

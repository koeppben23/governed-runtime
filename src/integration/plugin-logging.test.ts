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

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildLogSinks } from './plugin';
import type { LogEntry, LogSink } from '../logging/logger';

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
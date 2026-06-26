/**
 * @module logging/level-reloader.test
 * @description Tests for SIGUSR1-based runtime log level reloader.
 *
 * Covers:
 * - HAPPY: attach + triggerReload with valid JSON changes level
 * - BAD: invalid JSON → warn + level unchanged
 * - BAD: invalid level value → warn + level unchanged
 * - BAD: missing logging.level → warn + level unchanged
 * - CORNER: detach → triggerReload no-op
 * - CORNER: attach idempotent (second attach disposes first handler)
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 * @version v1
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger, type DynamicLogger } from './logger.js';
import { createLevelReloader, sigusr1Registrar, type SignalRegistrar } from './level-reloader.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeTempConfigDir(): string {
  return mkdtempSync(join(tmpdir(), 'fg-lr-'));
}

function writeConfig(dir: string, content: Record<string, unknown>): string {
  const path = join(dir, 'flowguard.json');
  writeFileSync(path, JSON.stringify(content));
  return path;
}

describe('LevelReloader', () => {
  let registrarCalls: Array<() => void> = [];
  let disposeCalls = 0;

  const testRegistrar: SignalRegistrar = {
    register(cb) {
      registrarCalls.push(cb);
      const idx = registrarCalls.length - 1;
      return () => {
        disposeCalls++;
        registrarCalls = registrarCalls.filter((_, i) => i !== idx);
      };
    },
  };

  let logger: DynamicLogger;

  beforeEach(() => {
    registrarCalls = [];
    disposeCalls = 0;
    logger = createLogger('info', [() => {}]);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('HAPPY: attach + triggerReload changes level', () => {
    const dir = makeTempConfigDir();
    try {
      const configPath = writeConfig(dir, { schemaVersion: 'v1', logging: { level: 'debug' } });
      const reloader = createLevelReloader(testRegistrar);

      expect(logger.getHealth().level).toBe('info');
      reloader.attach(logger, configPath);
      reloader.triggerReload();

      expect(logger.getHealth().level).toBe('debug');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('HAPPY: reload logs info when level changes', () => {
    const infoCalls: Array<[string, string, unknown]> = [];
    logger.info = (s, m, e) => {
      infoCalls.push([s, m, e]);
    };

    const dir = makeTempConfigDir();
    try {
      const configPath = writeConfig(dir, { schemaVersion: 'v1', logging: { level: 'debug' } });
      const reloader = createLevelReloader(testRegistrar);
      reloader.attach(logger, configPath);
      reloader.triggerReload();

      const reloadedCall = infoCalls.find(([, m]) => m === 'log level reloaded');
      expect(reloadedCall).toBeDefined();
      expect((reloadedCall![2] as Record<string, unknown>).oldLevel).toBe('info');
      expect((reloadedCall![2] as Record<string, unknown>).newLevel).toBe('debug');
      expect((reloadedCall![2] as Record<string, unknown>).source).toBe('SIGUSR1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('BAD: invalid JSON → warn + level unchanged', () => {
    const dir = makeTempConfigDir();
    try {
      const configPath = join(dir, 'flowguard.json');
      writeFileSync(configPath, '{invalid json}');

      const warnCalls: Array<[string, string, unknown]> = [];
      logger.warn = (s, m, e) => {
        warnCalls.push([s, m, e]);
      };

      const reloader = createLevelReloader(testRegistrar);
      expect(logger.getHealth().level).toBe('info');

      reloader.attach(logger, configPath);
      reloader.triggerReload();

      expect(logger.getHealth().level).toBe('info');
      expect(
        warnCalls.some(([, m]) => m === 'log level reload failed, keeping current level'),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('BAD: invalid level value → warn + level unchanged', () => {
    const dir = makeTempConfigDir();
    try {
      const configPath = writeConfig(dir, { schemaVersion: 'v1', logging: { level: 'fatal' } });

      const warnCalls: Array<[string, string, unknown]> = [];
      logger.warn = (s, m, e) => {
        warnCalls.push([s, m, e]);
      };

      const reloader = createLevelReloader(testRegistrar);
      expect(logger.getHealth().level).toBe('info');

      reloader.attach(logger, configPath);
      reloader.triggerReload();

      expect(logger.getHealth().level).toBe('info');
      expect(
        warnCalls.some(([, m]) => m === 'log level reload failed, keeping current level'),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('BAD: missing logging.level → warn + level unchanged', () => {
    const dir = makeTempConfigDir();
    try {
      const configPath = writeConfig(dir, { schemaVersion: 'v1' });

      const warnCalls: Array<[string, string, unknown]> = [];
      logger.warn = (s, m, e) => {
        warnCalls.push([s, m, e]);
      };

      const reloader = createLevelReloader(testRegistrar);
      expect(logger.getHealth().level).toBe('info');

      reloader.attach(logger, configPath);
      reloader.triggerReload();

      expect(logger.getHealth().level).toBe('info');
      expect(
        warnCalls.some(
          ([, m]) => m === 'log level reload skipped: logging.level missing in config',
        ),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CORNER: detach → triggerReload no-op', () => {
    const dir = makeTempConfigDir();
    try {
      const configPath = writeConfig(dir, { schemaVersion: 'v1', logging: { level: 'debug' } });
      const reloader = createLevelReloader(testRegistrar);
      reloader.attach(logger, configPath);
      reloader.detach();

      expect(logger.getHealth().level).toBe('info');
      reloader.triggerReload();
      expect(logger.getHealth().level).toBe('info');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CORNER: attach idempotent — second attach disposes first', () => {
    const dir = makeTempConfigDir();
    try {
      const configPath = writeConfig(dir, { schemaVersion: 'v1', logging: { level: 'debug' } });
      const reloader = createLevelReloader(testRegistrar);

      reloader.attach(logger, configPath);
      expect(registrarCalls.length).toBe(1);

      reloader.attach(logger, configPath);
      // Second attach should dispose the first handler exactly once
      expect(disposeCalls).toBe(1);
      expect(registrarCalls.length).toBe(1);

      reloader.triggerReload();
      expect(logger.getHealth().level).toBe('debug');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('sigusr1Registrar (production)', () => {
  it('invokes the callback when a real SIGUSR1 fires and dispose removes it', () => {
    let calls = 0;
    const before = process.listenerCount('SIGUSR1');
    const dispose = sigusr1Registrar.register(() => {
      calls++;
    });
    expect(process.listenerCount('SIGUSR1')).toBe(before + 1);
    process.emit('SIGUSR1', 'SIGUSR1' as never);
    expect(calls).toBe(1);
    dispose();
    expect(process.listenerCount('SIGUSR1')).toBe(before);
  });

  it('a throwing callback does not propagate out of the signal handler', () => {
    const dispose = sigusr1Registrar.register(() => {
      throw new Error('handler boom');
    });
    expect(() => process.emit('SIGUSR1', 'SIGUSR1' as never)).not.toThrow();
    dispose();
  });
});

/**
 * @module logging/level-reloader
 * @description SIGUSR1-based runtime log level reloader for FlowGuard.
 *
 * Allows changing the Active log level without restarting the process.
 * When enabled, sending SIGUSR1 re-reads `flowguard.json`, extracts
 * `logging.level`, and calls `logger.setLevel()`.
 *
 * Design:
 * - `SignalRegistrar` abstracts signal registration for testability.
 * - `createLevelReloader(registrar)` returns a `LevelReloader`.
 * - `attach(logger, configPath)` registers the handler (idempotent).
 * - `detach()` removes the handler.
 * - `triggerReload()` invokes the handler directly (for tests).
 * - Reload failure logs a warning and keeps the current level.
 * - Missing `logging.level` → skip + warn (no silent default).
 *
 * @version v1
 */

import { readFileSync } from 'node:fs';
import { LogLevelSchema, type LogLevel } from './log-level.js';
import { type DynamicLogger } from './logger.js';
import { serializeError } from './error-serialize.js';

/**
 * Abstract signal registrar — enables testing without real process signals.
 * `register()` returns a dispose function that removes the listener.
 */
export interface SignalRegistrar {
  register(cb: () => void): () => void;
}

/** Production SIGUSR1 registrar. */
export const sigusr1Registrar: SignalRegistrar = {
  register(cb) {
    // Wrap in a guard: a throw out of a signal handler crashes the process.
    // The reload logic already try/catches, but a custom logger whose warn
    // throws must not take the process down.
    const guarded = (): void => {
      try {
        cb();
      } catch {
        // never propagate out of a signal handler
      }
    };
    process.on('SIGUSR1', guarded);
    return () => process.off('SIGUSR1', guarded);
  },
};

/** Injectable runtime log level reloader (G5). */
export interface LevelReloader {
  /** Register the reloader with a logger and config file path. Idempotent. */
  attach(logger: DynamicLogger, configPath: string): void;
  /** Remove the signal handler and release references. */
  detach(): void;
  /** Execute reload logic directly — for tests and programmatic use. */
  triggerReload(): void;
}

/** Create a level reloader with the given signal registrar. */
export function createLevelReloader(registrar: SignalRegistrar): LevelReloader {
  let _logger: DynamicLogger | null = null;
  let _configPath: string | null = null;
  let _unregister: (() => void) | null = null;

  function reload(): void {
    if (!_unregister || !_logger || !_configPath) return;
    try {
      const raw = readFileSync(_configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      const rawLevel = parsed?.logging?.level;
      if (rawLevel === undefined) {
        _logger.warn('logging', 'log level reload skipped: logging.level missing in config', {
          configPath: _configPath,
        });
        return;
      }
      const newLevel = LogLevelSchema.parse(rawLevel) as LogLevel;
      const oldLevel = _logger.getHealth().level;
      if (newLevel !== oldLevel) {
        _logger.setLevel(newLevel);
        _logger.info('logging', 'log level reloaded', { oldLevel, newLevel, source: 'SIGUSR1' });
      }
    } catch (err) {
      _logger.warn('logging', 'log level reload failed, keeping current level', {
        error: serializeError(err),
        configPath: _configPath,
      });
    }
  }

  return {
    attach(logger, configPath) {
      _unregister?.();
      _logger = logger;
      _configPath = configPath;
      _unregister = registrar.register(reload);
    },
    detach() {
      _unregister?.();
      _unregister = null;
      _logger = null;
      _configPath = null;
    },
    triggerReload: reload,
  };
}

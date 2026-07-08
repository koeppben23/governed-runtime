/**
 * @module logging/log-level
 * @description Canonical log-level type and schema, owned by the logging layer.
 *
 * Previously these lived in `config/logging-config.ts`, which forced the logging
 * modules to import from `config` — a back-edge that deepened a config⇄logging
 * module-group coupling. The logging layer owns its own level type; `config`
 * re-exports it for config consumers, so the dependency flows config → logging
 * only.
 *
 * @version v1
 */

import { z } from 'zod';

export const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error', 'silent']);

export type LogLevel = z.infer<typeof LogLevelSchema>;

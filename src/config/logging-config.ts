import { z } from 'zod';

export const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error', 'silent']);

export type LogLevel = z.infer<typeof LogLevelSchema>;

/** Console output format for diagnostic log lines. */
export const ConsoleFormatSchema = z.enum(['text', 'json']).default('text');

export type ConsoleFormat = z.infer<typeof ConsoleFormatSchema>;

/** Maximum log file size in megabytes before rotation. */
export const MaxFileSizeMbSchema = z.number().int().min(1).max(1024).default(10);

export type MaxFileSizeMb = z.infer<typeof MaxFileSizeMbSchema>;

/** Maximum log entries per second per (service, level) before rate limiting kicks in. */
export const RateLimitMaxPerSecondSchema = z.number().int().min(1).max(10000).default(100);

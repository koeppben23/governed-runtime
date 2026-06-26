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

/** Enable SIGUSR1 handler for runtime log level changes. Default: false (opt-in). */
export const DynamicLogLevelEnabledSchema = z.boolean().default(false);

/** Enable OTLP log export (OpenTelemetry Logs). Default: false. */
export const OtlpEnabledSchema = z.boolean().default(false);

/**
 * OTLP endpoint URL. Must be a valid absolute URL. HTTPS is required unless
 * `allowInsecure` is explicitly enabled, because OTLP export is a network
 * egress and FlowGuard is offline-by-default. Validated here so an invalid or
 * cleartext endpoint fails closed at config parse time rather than silently
 * sending logs to an unintended target.
 */
export const OtlpEndpointSchema = z
  .string()
  .url('OTLP endpoint must be a valid absolute URL (e.g. https://collector:4318)')
  .optional();

/** Allow a cleartext http:// OTLP endpoint. Default: false (HTTPS required). */
export const OtlpAllowInsecureSchema = z.boolean().default(false);

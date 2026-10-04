/**
 * @module integration/review/review-logger-port
 * @description Structural diagnostic logger port for the review context.
 *
 * review/ must not import the logging layer; host/command callers inject the
 * adapter logger. This module has no imports.
 *
 * @version v1
 */

export interface ReviewDiagnosticLogger {
  warn(service: string, message: string, extra?: Record<string, unknown>): void;
}

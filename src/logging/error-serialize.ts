/**
 * @module logging/error-serialize
 * @description Structured error serialization for diagnostic log extras.
 *
 * Unlike `{ error: err.message }` which destroys stack traces, cause chains,
 * and error codes, `serializeError()` preserves the full diagnostic shape
 * while redacting sensitive strings via `sanitizeDiagnosticString()`.
 *
 * Design:
 * - Preserves: name, message, stack?, cause? (recursive), code?.
 * - All string fields are run through sanitizeDiagnosticString().
 * - Non-Error input is wrapped as `{ name: 'Error', message: String(input) }`.
 *
 * @version v1
 */

import { sanitizeDiagnosticString } from './redact.js';

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  cause?: SerializedError;
  code?: string;
}

export function serializeError(err: unknown): SerializedError {
  return _serializeError(err, new WeakSet<object>());
}

function _serializeError(err: unknown, seen: WeakSet<object>): SerializedError {
  if (err instanceof Error) {
    seen.add(err);

    const result: SerializedError = {
      name: sanitizeDiagnosticString(err.name),
      message: sanitizeDiagnosticString(err.message),
    };

    if (err.stack) {
      result.stack = sanitizeDiagnosticString(err.stack);
    }

    if (err.cause && err.cause instanceof Error && !seen.has(err.cause)) {
      result.cause = _serializeError(err.cause, seen);
    }

    const code = (err as NodeJS.ErrnoException).code;
    if (typeof code === 'string') {
      result.code = code;
    }

    return result;
  }

  if (typeof err === 'object' && err !== null) {
    const obj = err as Record<string, unknown>;
    return {
      name: typeof obj.name === 'string' ? sanitizeDiagnosticString(obj.name) : 'Error',
      message:
        typeof obj.message === 'string'
          ? sanitizeDiagnosticString(obj.message)
          : sanitizeDiagnosticString(String(err)),
    };
  }

  return {
    name: 'Error',
    message: sanitizeDiagnosticString(String(err)),
  };
}

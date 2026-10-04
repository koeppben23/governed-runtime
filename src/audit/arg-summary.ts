/**
 * @module audit/arg-summary
 * @description Audit arg summarizer — redacts secret-bearing keys and
 *              content-level secret patterns in scalar strings.
 */

import { sanitizeDiagnosticString } from '../logging/redact.js';

/** Maximum string length before truncation in arg summaries. */
const ARG_SUMMARY_TRUNCATION_LIMIT = 100;

const SECRET_BEARING_PATTERNS = [
  'secret',
  'token',
  'password',
  'passphrase',
  'credential',
  'authorization',
  'api_key',
  'apikey',
  'access_key',
  'accesskey',
  'private_key',
  'privatekey',
] as const;

function isSecretBearingKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    SECRET_BEARING_PATTERNS.some((pattern) => normalized.includes(pattern)) ||
    /(^|[_-])key($|[_-])/.test(normalized)
  );
}

/**
 * Summarize tool args for audit, redacting values on secret-bearing keys
 * and content-level secret patterns in all scalar strings via sanitizeDiagnosticString.
 * Scalar strings are truncated to ARG_SUMMARY_TRUNCATION_LIMIT chars.
 * Objects/arrays are replaced with type indicators.
 */
export function summarizeArgs(args: Record<string, unknown>): Record<string, string> {
  const summary: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) {
    if (isSecretBearingKey(key)) {
      summary[key] = '[REDACTED]';
    } else if (value === null || value === undefined) {
      summary[key] = 'null';
    } else if (typeof value === 'string') {
      const sanitized = sanitizeDiagnosticString(value);
      summary[key] =
        sanitized.length > ARG_SUMMARY_TRUNCATION_LIMIT
          ? sanitized.slice(0, ARG_SUMMARY_TRUNCATION_LIMIT) + '...'
          : sanitized;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      summary[key] = String(value);
    } else if (Array.isArray(value)) {
      summary[key] = `[Array(${value.length})]`;
    } else {
      summary[key] = '[Object]';
    }
  }
  return summary;
}

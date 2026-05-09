/**
 * @module logging/redact
 * @description Redaction helpers for structured logging extra fields.
 *
 * Some log points handle sensitive data (token paths, JWKS URIs, issuers).
 * These helpers strip or hash sensitive values before they enter log sinks.
 *
 * @version v1
 */

import { createHash } from 'node:crypto';

/**
 * Redact identity-related log extra fields.
 *
 * - Paths (tokenPath, jwksPath) → basename only, no full path
 * - URIs (jwksUri) → hostname only, no full URL/path/query
 * - Issuer (issuer) → SHA-256 first 8 hex chars, not full value
 * - Error (error) → removes paths, URLs, and line references, keeps message class
 * - All other fields pass through unchanged
 *
 * URL regex matches http/https URLs and absolute file paths.
 */
export function redactIdentityExtra(
  extra?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!extra) return undefined;

  const redacted: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(extra)) {
    if (key === 'tokenPath' || key === 'jwksPath') {
      if (typeof value === 'string' && value.trim()) {
        redacted[key] = `[redacted:${basename$0(value)}]`;
      }
    } else if (key === 'jwksUri') {
      if (typeof value === 'string' && value.trim()) {
        try {
          const url = new URL(value);
          redacted[key] = `[redacted:${url.hostname}]`;
        } catch {
          redacted[key] = '[redacted:invalid-uri]';
        }
      }
    } else if (key === 'issuer') {
      if (typeof value === 'string' && value.trim()) {
        const hash = createHash('sha256').update(value).digest('hex').slice(0, 8);
        redacted[key] = `[hashed:${hash}]`;
      }
    } else if (key === 'error') {
      if (typeof value === 'string') {
        redacted[key] = sanitizeErrorMessage(value);
      } else {
        redacted[key] = value;
      }
    } else {
      redacted[key] = value;
    }
  }

  return redacted;
}

/**
 * Sanitize an error message by stripping absolute paths and URLs.
 * Keeps the error class/type and the last path segment.
 */
function sanitizeErrorMessage(msg: string): string {
  return (
    msg
      // Strip https:// URLs FIRST (before path regex can grab them)
      .replace(/https?:\/\/[^\s),]+/g, (m) => {
        try {
          return `[url:${new URL(m).hostname}]`;
        } catch {
          return '[url:redacted]';
        }
      })
      // Strip absolute file paths: /home/user/... or C:\Users\...
      .replace(/\/[\w.-]+(?:\/[\w.-]+)+(\.[a-z]+)?/g, (m) => {
        // Skip if already redacted as URL or path
        if (m.includes('[url:') || m.includes('[path:')) return m;
        const b = m.split(/[/\\]/).pop() ?? m;
        return b && b.length < m.length ? `[path:${b}]` : m;
      })
      // Strip line:column references
      .replace(/:\d+:\d+/g, '')
      // Strip ENOENT path from errors
      .replace(/ENOENT\s*:\s*\S+/g, 'ENOENT: [redacted]')
  );
}

function basename$0(p: string): string {
  return p.split(/[/\\]/).pop() ?? p;
}

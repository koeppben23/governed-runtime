/**
 * @module logging/redact
 * @description Redaction helpers for structured logging.
 *
 * Two layers:
 * - `redactIdentityExtra()` — call-site redaction of known identity keys.
 * - `redactExtra()` / `redactMessage()` — central, sink-layer defense-in-depth
 *   applied to EVERY log entry's message and extra by the logger, so a call site
 *   that forgets to redact cannot leak.
 *
 * `sanitizeDiagnosticString()` is the general-purpose string redactor. It strips:
 * - absolute POSIX file paths (`/home/user/...`)
 * - Windows drive paths (`C:\Users\...`) and UNC paths (`\\server\share\...`)
 * - http(s):// URLs (keeps hostname)
 * - line:column references
 * - ENOENT paths
 * - high-confidence secret values (bearer tokens, JWTs, sk-/sk_live_ keys,
 *   `password=`/`token=`/`secret=`/`api_key=` assignments)
 *
 * Secret detection is deliberately CONSERVATIVE: only unambiguous shapes are
 * redacted, to avoid mangling diagnostic content. Generic high-entropy
 * heuristics are intentionally NOT applied.
 *
 * @version v3
 */

import { hashTextShort } from '../shared/hashing.js';

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
        const hash = hashTextShort(value, 8);
        redacted[key] = `[hashed:${hash}]`;
      }
    } else if (key === 'error') {
      if (typeof value === 'string') {
        redacted[key] = sanitizeDiagnosticString(value);
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
 * Replace a matched absolute path with its last segment, e.g.
 * `C:\Users\bob\token.json` -> `[path:token.json]`. Falls back to
 * `[path:redacted]` when no usable trailing segment is found.
 */
function redactPathMatch(match: string): string {
  const segment = match.split(/[/\\]/).filter(Boolean).pop();
  if (segment && segment.length < match.length) {
    return `[path:${segment}]`;
  }
  return '[path:redacted]';
}

/**
 * Sanitize a diagnostic string by stripping absolute paths, URLs, and
 * high-confidence secret values. Used by the central log redactor and
 * serializeError().
 *
 * Keeps the error class/type and the last path segment.
 */
export function sanitizeDiagnosticString(msg: string): string {
  return (
    msg
      // High-confidence secret values FIRST (before path/URL passes can eat them).
      // Bearer tokens.
      .replace(/\b[Bb]earer\s+[A-Za-z0-9._~+/-]+=*/g, 'Bearer [redacted]')
      // JSON Web Tokens (three base64url segments).
      .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, '[redacted:jwt]')
      // OpenAI-style keys (sk-..., sk_live_..., sk-proj-...).
      .replace(/\bsk[-_][A-Za-z0-9_-]{12,}/g, '[redacted:key]')
      // key=value secret assignments (password/passwd/secret/token/api_key/apikey).
      .replace(
        /\b(password|passwd|secret|token|api[_-]?key|apikey)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
        '$1=[redacted]',
      )
      // Strip http(s):// URLs (keep hostname).
      .replace(/https?:\/\/[^\s),]+/g, (m) => {
        try {
          return `[url:${new URL(m).hostname}]`;
        } catch {
          return '[url:redacted]';
        }
      })
      // UNC paths: \\server\share\...
      .replace(/\\\\[\w.-]+(?:\\[^\s\\]+)+/g, redactPathMatch)
      // Windows drive paths: C:\Users\... (allows spaces in segments).
      .replace(/\b[A-Za-z]:\\(?:[^\s\\]+\\?)+/g, redactPathMatch)
      // Absolute POSIX file paths: /home/user/... (two or more segments, matched
      // anywhere — including after quotes/equals — so quoted paths are redacted).
      .replace(/\/[\w.-]+(?:\/[\w.-]+)+/g, (m) => {
        if (m.includes('[url:') || m.includes('[path:')) return m;
        const b = m.split(/[/\\]/).pop() ?? m;
        return b && b.length < m.length ? `[path:${b}]` : m;
      })
      // Strip line:column references.
      .replace(/:\d+:\d+/g, '')
      // Strip ENOENT path from errors.
      .replace(/ENOENT\s*:\s*\S+/g, 'ENOENT: [redacted]')
  );
}

/** Redact a single log message string (central, sink-layer). */
export function redactMessage(message: string): string {
  return sanitizeDiagnosticString(message);
}

/**
 * Central, sink-layer redaction for an entire `extra` object. Deep-walks nested
 * objects and arrays, sanitizing every string value (R6), and is null-safe (R7).
 * Cycles are handled via a seen-set. This is defense-in-depth: it runs on EVERY
 * log entry regardless of whether the call site already redacted.
 */
export function redactExtra(extra?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (extra === undefined || extra === null) return extra ?? undefined;
  return redactValue(extra, new WeakSet<object>()) as Record<string, unknown>;
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return sanitizeDiagnosticString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[redacted:circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = redactValue(v, seen);
  }
  return out;
}

function basename$0(p: string): string {
  return p.split(/[/\\]/).pop() ?? p;
}

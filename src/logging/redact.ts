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
 * Cheap pre-filter: a string can only need redaction if it contains a path/URL
 * separator (`/ \ :`), a key=value separator (`=`), or one of the secret
 * keywords / token prefixes. Used to short-circuit sanitizeDiagnosticString.
 */
const REDACTION_TRIGGER =
  /[/\\:=]|password|passwd|secret|token|api[_-]?key|apikey|bearer|eyJ|sk[-_]/i;

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
  // Robustness: callers are typed `string`, but JS interop (MCP, adapters) can
  // pass a non-string. Coerce so `.replace` cannot throw a TypeError.
  if (typeof msg !== 'string') {
    try {
      msg = String(msg);
    } catch {
      return '[unprintable]';
    }
  }
  // Fast path: skip the regex passes when no redaction-triggering character is
  // present. Paths/URLs/secrets all require at least one of / \ : = or the
  // letters used by the secret keywords. This keeps the per-log-call cost near
  // zero for the overwhelmingly common case of clean diagnostic text.
  if (!REDACTION_TRIGGER.test(msg)) return msg;
  return (
    msg
      // High-confidence secret values FIRST (before path/URL passes can eat them).
      // Bearer tokens (case-insensitive — RFC 6750 auth schemes are not case-sensitive).
      .replace(/\bbearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
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
  );
}

/** Redact a single log message string (central, sink-layer). Never throws. */
export function redactMessage(message: string): string {
  try {
    return sanitizeDiagnosticString(message);
  } catch {
    // Redaction must never break the logging contract ("logger never throws").
    return '[redaction-error]';
  }
}

/** Maximum nesting depth walked by redactValue before bailing out. Guards
 *  against stack overflow on deep (acyclic) extra objects. */
const MAX_REDACT_DEPTH = 64;

/**
 * Central, sink-layer redaction for an entire `extra` object. Deep-walks nested
 * objects and arrays, sanitizing every string value (R6), and is null-safe (R7).
 * Cycles are handled via a seen-set and depth via MAX_REDACT_DEPTH. This is
 * defense-in-depth: it runs on EVERY log entry regardless of whether the call
 * site already redacted, so it MUST NOT throw — any failure (throwing getter,
 * exotic proxy, depth) degrades to a safe placeholder.
 */
export function redactExtra(extra?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (extra === undefined || extra === null) return extra ?? undefined;
  try {
    return redactValue(extra, new WeakSet<object>(), 0) as Record<string, unknown>;
  } catch {
    return { redaction: '[redaction-error]' };
  }
}

function redactValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === 'string') return sanitizeDiagnosticString(value);
  // bigint is not JSON-serializable — coerce so a sink's JSON.stringify cannot
  // throw and silently drop the whole entry.
  if (typeof value === 'bigint') return `${value}`;
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[redacted:circular]';
  if (depth >= MAX_REDACT_DEPTH) return '[redacted:too-deep]';
  seen.add(value);

  // Built-in objects do not survive a generic Object.entries() walk: Date/Map/
  // Set/RegExp collapse to {}, Buffer becomes an index map, and a raw Error loses
  // its (non-enumerable) name/message/stack. Coerce them to safe, sanitized forms
  // BEFORE the generic walk so values are neither corrupted nor leaked.
  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      name: sanitizeDiagnosticString(value.name),
      message: sanitizeDiagnosticString(value.message),
    };
    if (value.stack) out.stack = sanitizeDiagnosticString(value.stack);
    const code = (value as NodeJS.ErrnoException).code;
    if (typeof code === 'string') out.code = code;
    return out;
  }
  if (value instanceof Date) return safeDateToISO(value);
  if (value instanceof RegExp) return value.toString();
  if (value instanceof Map) return `[Map]`;
  if (value instanceof Set) return `[Set]`;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return `[binary:${value.byteLength}]`;
  }

  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, seen, depth + 1));
  }

  // Honor a custom toJSON() (e.g. class instances that intentionally project a
  // subset) before walking raw own-properties, so the redactor cannot surface
  // private fields the value meant to hide or drop derived getters.
  const maybeToJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof maybeToJSON === 'function') {
    try {
      return redactValue((value as { toJSON: () => unknown }).toJSON(), seen, depth + 1);
    } catch {
      // fall through to the generic walk if toJSON throws
    }
  }

  // The generic walk can throw if an enumerable getter or a proxy trap throws.
  // Catch per-object so one hostile property cannot break the whole log call.
  try {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      try {
        out[key] = redactValue(v, seen, depth + 1);
      } catch {
        out[key] = '[redaction-error]';
      }
    }
    return out;
  } catch {
    return '[unredactable-object]';
  }
}

function safeDateToISO(d: Date): string {
  // An invalid Date throws on toISOString(); guard it.
  try {
    return d.toISOString();
  } catch {
    return '[invalid-date]';
  }
}

function basename$0(p: string): string {
  return p.split(/[/\\]/).pop() ?? p;
}

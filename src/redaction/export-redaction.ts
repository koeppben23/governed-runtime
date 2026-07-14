/**
 * @module redaction/export-redaction
 * @description Export-time redaction for archive artifacts.
 *
 * Runtime/session SSOT stays raw. This module only transforms export artifacts.
 */

import { hashTextShort } from '../shared/hashing.js';
import { sanitizeDiagnosticString } from '../logging/redact.js';

export type RedactionMode = 'none' | 'basic' | 'strict';

export interface ArchiveRedactionPolicy {
  readonly mode: RedactionMode;
  readonly includeRaw: boolean;
}

export interface RedactionOutcome {
  readonly redactedPath: string;
  readonly rawPath: string;
}

export function stableMask(value: string, mode: RedactionMode): string {
  if (mode === 'none') return value;
  if (mode === 'basic') return '[REDACTED]';
  const token = hashTextShort(value, 12);
  return `[REDACTED:${token}]`;
}

function isPathBearingKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized === 'worktree' ||
    normalized === 'workspace' ||
    normalized === 'sessiondir' ||
    normalized.includes('path') ||
    normalized.includes('directory') ||
    /(^|[_-])dir($|[_-])/.test(normalized)
  );
}

const MAX_REDACT_DEPTH = 64;

function redactUnknownStrings(
  value: unknown,
  mode: RedactionMode,
  allowList: ReadonlySet<string>,
  sensitiveKeys?: ReadonlySet<string>,
): unknown {
  const active = new WeakSet<object>();
  return _walk(value, 0);

  function _walk(v: unknown, depth: number, key?: string): unknown {
    if (mode === 'none') return v;

    if (depth >= MAX_REDACT_DEPTH) {
      throw new Error('Redaction failed: maximum nesting depth exceeded');
    }

    if (typeof v === 'string') {
      return redactStringField(v, key);
    }

    if (v === null || typeof v !== 'object') return v;

    if (active.has(v)) {
      throw new Error('Redaction failed: circular reference detected');
    }

    active.add(v);

    try {
      if (Array.isArray(v)) {
        return v.map((item) => _walk(item, depth + 1));
      }

      const result: Record<string, unknown> = {};
      for (const [k, item] of Object.entries(v)) {
        result[k] = _walk(item, depth + 1, k);
      }
      return result;
    } finally {
      active.delete(v);
    }
  }

  function redactStringField(s: string, k?: string): string {
    if (k === undefined) return stableMask(s, mode);

    if (isPathBearingKey(k)) {
      return stableMask(s, mode);
    }

    if (sensitiveKeys?.has(k)) {
      return stableMask(s, mode);
    }

    if (allowList.has(k)) {
      return s;
    }

    return stableMask(s, mode);
  }
}

// ─── Allow-Lists ─────────────────────────────────────────────────────────

const EXPORT_BASE_STRING_ALLOW_LIST = new Set([
  'decisionId',
  'timestamp',
  'schemaVersion',
  'checkId',
  'phase',
  'mode',
  'kind',
  'type',
  'id',
  'status',
  'checkerId',
]);

const REVIEW_REPORT_STRING_ALLOW_LIST = new Set([
  ...EXPORT_BASE_STRING_ALLOW_LIST,
  'source',
  'verdict',
  'severity',
]);

const REVIEW_REPORT_SENSITIVE_KEYS = new Set([
  'message',
  'detail',
  'ref',
  'title',
  'initiatedBy',
  'decidedBy',
]);

const DECISION_RECEIPT_STRING_ALLOW_LIST = new Set([
  ...EXPORT_BASE_STRING_ALLOW_LIST,
  'source',
  'verdict',
  'gatePhase',
  'fromPhase',
  'toPhase',
  'event',
  'policyMode',
]);

const DECISION_RECEIPT_SENSITIVE_KEYS = new Set(['decidedBy', 'rationale']);

const SESSION_STATE_STRING_ALLOW_LIST = new Set([
  ...EXPORT_BASE_STRING_ALLOW_LIST,
  'verdict',
  'taskClass',
  'event',
  'action',
  'profile',
  'fromPhase',
  'toPhase',
  'gatePhase',
  'errorPhase',
  'finalPhase',
]);

const SESSION_STATE_SENSITIVE_KEYS = new Set(['initiatedBy']);

const AUDIT_DETAIL_STRING_ALLOW_LIST = new Set([
  ...EXPORT_BASE_STRING_ALLOW_LIST,
  'tool',
  'verdict',
  'gatePhase',
  'fromPhase',
  'toPhase',
  'event',
  'policyMode',
  'errorPhase',
  'action',
  'finalPhase',
  'errorMessage',
]);

// ─── Public Redaction Functions ──────────────────────────────────────────

export function redactReviewReport(
  payload: Record<string, unknown>,
  mode: RedactionMode,
): Record<string, unknown> {
  if (mode === 'none') return payload;
  const out = structuredClone(payload);

  return redactUnknownStrings(
    out,
    mode,
    REVIEW_REPORT_STRING_ALLOW_LIST,
    REVIEW_REPORT_SENSITIVE_KEYS,
  ) as Record<string, unknown>;
}

export function redactDecisionReceipts(
  payload: Record<string, unknown>,
  mode: RedactionMode,
): Record<string, unknown> {
  if (mode === 'none') return payload;
  const out = structuredClone(payload);

  return redactUnknownStrings(
    out,
    mode,
    DECISION_RECEIPT_STRING_ALLOW_LIST,
    DECISION_RECEIPT_SENSITIVE_KEYS,
  ) as Record<string, unknown>;
}

export function redactSessionState(
  payload: Record<string, unknown>,
  mode: RedactionMode,
): Record<string, unknown> {
  if (mode === 'none') return payload;
  const source = structuredClone(payload);

  const result = redactUnknownStrings(
    source,
    mode,
    SESSION_STATE_STRING_ALLOW_LIST,
    SESSION_STATE_SENSITIVE_KEYS,
  ) as Record<string, unknown>;

  maskIdentityFromSource(source, result, 'actorInfo', mode);
  maskIdentityFromSource(source, result, 'initiatedByIdentity', mode);

  return result;
}

function maskIdentityFromSource(
  source: Record<string, unknown>,
  result: Record<string, unknown>,
  key: string,
  mode: RedactionMode,
): void {
  const srcObj = source[key];
  if (!srcObj || typeof srcObj !== 'object') return;
  const srcRecord = srcObj as Record<string, unknown>;
  const resultObj = result[key];
  if (!resultObj || typeof resultObj !== 'object') return;
  const resultRecord = resultObj as Record<string, unknown>;

  if (typeof srcRecord.id === 'string') resultRecord.id = stableMask(srcRecord.id, mode);
  if (typeof srcRecord.displayName === 'string')
    resultRecord.displayName = stableMask(srcRecord.displayName, mode);
  if (typeof srcRecord.email === 'string') resultRecord.email = stableMask(srcRecord.email, mode);
}

export function redactAuditDetail(
  detail: Record<string, unknown>,
  mode: RedactionMode,
): Record<string, unknown> {
  if (mode === 'none') return detail;
  const out = structuredClone(detail);

  if (typeof out.errorMessage === 'string') {
    out.errorMessage = sanitizeDiagnosticString(out.errorMessage);
  }

  return redactUnknownStrings(out, mode, AUDIT_DETAIL_STRING_ALLOW_LIST) as Record<string, unknown>;
}

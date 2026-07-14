/**
 * @module redaction/export-redaction
 * @description Export-time redaction for archive artifacts.
 *
 * Runtime/session SSOT stays raw. This module only transforms export artifacts.
 */

import { hashTextShort } from '../shared/hashing.js';

export type RedactionMode = 'none' | 'basic' | 'strict';

export interface ArchiveRedactionPolicy {
  readonly mode: RedactionMode;
  readonly includeRaw: boolean;
}

export interface RedactionOutcome {
  readonly redactedPath: string;
  readonly rawPath: string;
}

function stableMask(value: string, mode: RedactionMode): string {
  if (mode === 'none') return value;
  if (mode === 'basic') return '[REDACTED]';
  const token = hashTextShort(value, 12);
  return `[REDACTED:${token}]`;
}

function isRedactedExportValue(value: string): boolean {
  return value === '[REDACTED]' || value.startsWith('[REDACTED:');
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

  function redactStringField(s: string, key?: string): string {
    if (isRedactedExportValue(s)) return s;

    if (key !== undefined && isPathBearingKey(key)) {
      return stableMask(s, mode);
    }

    return key !== undefined && allowList.has(key) ? s : stableMask(s, mode);
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

// ─── Known-Field Redaction Helpers ───────────────────────────────────────

function redactFindings(findings: Record<string, unknown>[], mode: RedactionMode): void {
  for (const finding of findings) {
    if (typeof finding.message === 'string') {
      finding.message = stableMask(finding.message, mode);
    }
  }
}

function redactValidationSummary(
  validationSummary: Record<string, unknown>[],
  mode: RedactionMode,
): void {
  for (const item of validationSummary) {
    if (typeof item.detail === 'string') {
      item.detail = stableMask(item.detail, mode);
    }
  }
}

function redactCompleteness(completeness: Record<string, unknown>, mode: RedactionMode): void {
  const fourEyes =
    typeof completeness.fourEyes === 'object' && completeness.fourEyes !== null
      ? (completeness.fourEyes as Record<string, unknown>)
      : null;

  if (fourEyes) {
    if (typeof fourEyes.initiatedBy === 'string') {
      fourEyes.initiatedBy = stableMask(fourEyes.initiatedBy, mode);
    }
    if (typeof fourEyes.decidedBy === 'string') {
      fourEyes.decidedBy = stableMask(fourEyes.decidedBy, mode);
    }
    if (typeof fourEyes.detail === 'string') {
      fourEyes.detail = stableMask(fourEyes.detail, mode);
    }
  }

  const slots = Array.isArray(completeness.slots)
    ? (completeness.slots as Array<Record<string, unknown>>)
    : [];
  for (const slot of slots) {
    if (typeof slot.detail === 'string') {
      slot.detail = stableMask(slot.detail, mode);
    }
  }
}

function redactReferences(references: Record<string, unknown>[], mode: RedactionMode): void {
  for (const ref of references) {
    if (typeof ref.ref === 'string') {
      ref.ref = stableMask(ref.ref, mode);
    }
    if (typeof ref.title === 'string') {
      ref.title = stableMask(ref.title, mode);
    }
  }
}

function redactIdentityFields(obj: Record<string, unknown>, mode: RedactionMode): void {
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === 'string') {
      obj[key] = stableMask(val, mode);
    }
  }
}

// ─── Public Redaction Functions ──────────────────────────────────────────

/**
 * Redact a flowguard-review-report.v1 payload.
 */
export function redactReviewReport(
  payload: Record<string, unknown>,
  mode: RedactionMode,
): Record<string, unknown> {
  if (mode === 'none') return payload;

  const out = structuredClone(payload);
  const report = out;

  const findings = Array.isArray(report.findings)
    ? (report.findings as Array<Record<string, unknown>>)
    : [];
  redactFindings(findings, mode);

  const validationSummary = Array.isArray(report.validationSummary)
    ? (report.validationSummary as Array<Record<string, unknown>>)
    : [];
  redactValidationSummary(validationSummary, mode);

  const completeness =
    typeof report.completeness === 'object' && report.completeness !== null
      ? (report.completeness as Record<string, unknown>)
      : null;
  if (completeness) {
    redactCompleteness(completeness, mode);
  }

  const references = Array.isArray(report.references)
    ? (report.references as Array<Record<string, unknown>>)
    : [];
  redactReferences(references, mode);

  return redactUnknownStrings(out, mode, REVIEW_REPORT_STRING_ALLOW_LIST) as Record<
    string,
    unknown
  >;
}

/**
 * Redact decision-receipts.v1 payload.
 */
export function redactDecisionReceipts(
  payload: Record<string, unknown>,
  mode: RedactionMode,
): Record<string, unknown> {
  if (mode === 'none') return payload;
  const out = structuredClone(payload);
  const root = out;
  const receipts = Array.isArray(root.receipts)
    ? (root.receipts as Array<Record<string, unknown>>)
    : [];

  for (const receipt of receipts) {
    if (typeof receipt.decidedBy === 'string') {
      receipt.decidedBy = stableMask(receipt.decidedBy, mode);
    }
    if (typeof receipt.rationale === 'string') {
      receipt.rationale = stableMask(receipt.rationale, mode);
    }
  }

  return redactUnknownStrings(out, mode, DECISION_RECEIPT_STRING_ALLOW_LIST) as Record<
    string,
    unknown
  >;
}

/**
 * Redact session-state.json for archive export.
 */
export function redactSessionState(
  payload: Record<string, unknown>,
  mode: RedactionMode,
): Record<string, unknown> {
  if (mode === 'none') return payload;
  const out = structuredClone(payload);

  if (typeof out.initiatedBy === 'string') {
    out.initiatedBy = stableMask(out.initiatedBy, mode);
  }
  if (out.initiatedByIdentity && typeof out.initiatedByIdentity === 'object') {
    redactIdentityFields(out.initiatedByIdentity as Record<string, unknown>, mode);
  }
  if (out.actorInfo && typeof out.actorInfo === 'object') {
    redactIdentityFields(out.actorInfo as Record<string, unknown>, mode);
  }

  for (const [key, val] of Object.entries(out)) {
    if (typeof val === 'string' && isPathBearingKey(key)) {
      out[key] = stableMask(val, mode);
    }
  }

  return redactUnknownStrings(out, mode, SESSION_STATE_STRING_ALLOW_LIST) as Record<
    string,
    unknown
  >;
}

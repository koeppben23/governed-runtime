/**
 * @module redaction/export-redaction
 * @description Export-time redaction for archive artifacts.
 *
 * Runtime/session SSOT stays raw. This module only transforms export artifacts.
 */

import { createHash } from "node:crypto";

export type RedactionMode = "none" | "basic" | "strict";

export interface ArchiveRedactionPolicy {
  readonly mode: RedactionMode;
  readonly includeRaw: boolean;
}

export interface RedactionOutcome {
  readonly redactedPath: string;
  readonly rawPath: string;
}

function stableMask(value: string, mode: Exclude<RedactionMode, "none">): string {
  const base = value;
  if (mode === "basic") return "[REDACTED]";
  const token = createHash("sha256").update(base).digest("hex").slice(0, 12);
  return `[REDACTED:${token}]`;
}

/**
 * Redact a flowguard-review-report.v1 payload.
 */
export function redactReviewReport(
  payload: Record<string, unknown>,
  mode: RedactionMode,
): Record<string, unknown> {
  if (mode === "none") return payload;

  const out = structuredClone(payload);
  const report = out as Record<string, unknown>;

  const findings = Array.isArray(report.findings)
    ? (report.findings as Array<Record<string, unknown>>)
    : [];
  for (const finding of findings) {
    if (typeof finding.message === "string") {
      finding.message = stableMask(finding.message, mode);
    }
  }

  const validationSummary = Array.isArray(report.validationSummary)
    ? (report.validationSummary as Array<Record<string, unknown>>)
    : [];
  for (const item of validationSummary) {
    if (typeof item.detail === "string") {
      item.detail = stableMask(item.detail, mode);
    }
  }

  const completeness =
    typeof report.completeness === "object" && report.completeness !== null
      ? (report.completeness as Record<string, unknown>)
      : null;

  if (completeness) {
    const fourEyes =
      typeof completeness.fourEyes === "object" && completeness.fourEyes !== null
        ? (completeness.fourEyes as Record<string, unknown>)
        : null;
    if (fourEyes) {
      if (typeof fourEyes.initiatedBy === "string") {
        fourEyes.initiatedBy = stableMask(fourEyes.initiatedBy, mode);
      }
      if (typeof fourEyes.decidedBy === "string") {
        fourEyes.decidedBy = stableMask(fourEyes.decidedBy, mode);
      }
      if (typeof fourEyes.detail === "string") {
        fourEyes.detail = stableMask(fourEyes.detail, mode);
      }
    }

    const slots = Array.isArray(completeness.slots)
      ? (completeness.slots as Array<Record<string, unknown>>)
      : [];
    for (const slot of slots) {
      if (typeof slot.detail === "string") {
        slot.detail = stableMask(slot.detail, mode);
      }
    }
  }

  return out;
}

/**
 * Redact decision-receipts.v1 payload.
 */
export function redactDecisionReceipts(
  payload: Record<string, unknown>,
  mode: RedactionMode,
): Record<string, unknown> {
  if (mode === "none") return payload;
  const out = structuredClone(payload);
  const root = out as Record<string, unknown>;
  const receipts = Array.isArray(root.receipts)
    ? (root.receipts as Array<Record<string, unknown>>)
    : [];

  for (const receipt of receipts) {
    if (typeof receipt.decidedBy === "string") {
      receipt.decidedBy = stableMask(receipt.decidedBy, mode);
    }
    if (typeof receipt.rationale === "string") {
      receipt.rationale = stableMask(receipt.rationale, mode);
    }
  }

  return out;
}

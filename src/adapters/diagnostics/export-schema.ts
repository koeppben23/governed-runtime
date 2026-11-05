/**
 * @module adapters/diagnostics/export-schema
 * @description Versioned, read-only diagnostic snapshot contract.
 *
 * A diagnostic snapshot is not governance evidence and never authorizes a
 * transition. Schema validation protects the export boundary; it does not make
 * the captured host data trusted.
 */

import { z } from 'zod';

export const DIAGNOSTIC_EXPORT_SCHEMA_VERSION = 'diagnostic-export.v1' as const;

export const DiagnosticCaptureStatus = z.enum(['COMPLETE', 'PARTIAL', 'NOT_VERIFIED']);
export type DiagnosticCaptureStatus = z.infer<typeof DiagnosticCaptureStatus>;

const DiagnosticWarning = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    sessionId: z.string().min(1).nullable(),
    source: z.enum(['state', 'audit', 'host', 'review', 'logs', 'capture']),
  })
  .strict()
  .readonly();

export type DiagnosticWarning = z.infer<typeof DiagnosticWarning>;

const DiagnosticFileReceipt = z
  .object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();

export const DiagnosticManifest = z
  .object({
    schemaVersion: z.literal(DIAGNOSTIC_EXPORT_SCHEMA_VERSION),
    captureId: z.string().uuid(),
    createdAt: z.string().datetime(),
    status: DiagnosticCaptureStatus,
    redaction: z
      .object({
        mode: z.enum(['basic', 'pseudonymous', 'none']),
        rawIncluded: z.boolean(),
        limitations: z.array(z.string()),
      })
      .strict()
      .readonly(),
    boundary: z
      .object({
        workspaceFingerprint: z.string().min(1).nullable(),
        worktreeName: z.string().min(1).nullable(),
        sessionsKnown: z.number().int().nonnegative(),
        sessionsWithState: z.number().int().nonnegative(),
        sessionsWithoutState: z.number().int().nonnegative(),
        sessionsUnavailable: z.number().int().nonnegative(),
        sessionsLineageUnverified: z.number().int().nonnegative(),
        maxSessions: z.number().int().positive(),
        maxFileBytes: z.number().int().positive(),
        maxTotalBytes: z.number().int().positive(),
        maxDurationMs: z.number().int().positive(),
        hostHistory: z.enum(['included', 'unavailable', 'not_requested']),
      })
      .strict()
      .readonly(),
    counts: z
      .object({
        sessions: z.number().int().nonnegative(),
        auditEvents: z.number().int().nonnegative(),
        hostMessages: z.number().int().nonnegative(),
        warnings: z.number().int().nonnegative(),
      })
      .strict()
      .readonly(),
    completeness: z
      .object({
        lineage: z.enum(['complete', 'partial', 'not_verified']),
        canonicalState: z.enum(['complete', 'partial', 'not_verified']),
        hostHistory: z.enum(['complete', 'partial', 'not_requested', 'not_verified']),
      })
      .strict()
      .readonly(),
    files: z.array(DiagnosticFileReceipt),
    warnings: z.array(DiagnosticWarning),
  })
  .strict()
  .readonly();

export type DiagnosticManifest = z.infer<typeof DiagnosticManifest>;

const DiagnosticSessionRole = z.enum(['root', 'reviewer', 'continuation', 'unknown']);
const DiagnosticSessionState = z.enum(['captured', 'absent', 'unavailable']);
const DiagnosticHostHistory = z.enum(['captured', 'unavailable', 'not_requested']);

const DiagnosticSessionNode = z
  .object({
    sessionId: z.string().min(1),
    parentSessionId: z.string().min(1).nullable(),
    role: DiagnosticSessionRole,
    discoveredBy: z.array(
      z.enum(['root', 'review_invocation', 'review_attempt', 'review_observation', 'host_parent']),
    ),
    state: DiagnosticSessionState,
    lineage: z.enum(['verified', 'not_verified']),
    phase: z.string().min(1).nullable(),
    binding: z.enum(['verified', 'mismatch', 'unknown']),
    hostHistory: DiagnosticHostHistory,
    warningCodes: z.array(z.string()),
  })
  .strict()
  .readonly();

export const DiagnosticSessionGraph = z
  .object({
    schemaVersion: z.literal(DIAGNOSTIC_EXPORT_SCHEMA_VERSION),
    rootSessionId: z.string().min(1),
    sessions: z.array(DiagnosticSessionNode),
  })
  .strict()
  .readonly();

export type DiagnosticSessionGraph = z.infer<typeof DiagnosticSessionGraph>;

const DiagnosticTimelineEntry = z
  .object({
    at: z.string().min(1).nullable(),
    source: z.enum(['audit', 'host', 'capture']),
    sessionId: z.string().min(1).nullable(),
    kind: z.string().min(1),
    reference: z.string().min(1).nullable(),
  })
  .strict()
  .readonly();

export const DiagnosticTimeline = z
  .object({
    schemaVersion: z.literal(DIAGNOSTIC_EXPORT_SCHEMA_VERSION),
    entries: z.array(DiagnosticTimelineEntry),
    note: z.literal(
      'Chronology is navigational only; timestamps never establish lineage or causality.',
    ),
  })
  .strict()
  .readonly();

export type DiagnosticTimeline = z.infer<typeof DiagnosticTimeline>;

/** A bounded diagnostic request; limits are explicit and recorded in the manifest. */
export interface DiagnosticExportLimits {
  readonly maxSessions: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly hostTimeoutMs: number;
  readonly maxDurationMs: number;
}

export const DEFAULT_DIAGNOSTIC_LIMITS: DiagnosticExportLimits = Object.freeze({
  maxSessions: 100,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  hostTimeoutMs: 60_000,
  maxDurationMs: 120_000,
});

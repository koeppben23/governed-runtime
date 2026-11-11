/**
 * @module adapters/diagnostics/types
 * @description Internal diagnostic-export types shared by collection, manifest
 * and artifact modules. Not a public authority.
 */

import type { AuditEvent } from '../../state/evidence-audit.js';
import type { SessionState } from '../../state/schema.js';
import type { SessionAuthorityResolution } from '../session-authority.js';
import type { DiagnosticWarning } from './export-schema.js';
import type { HostTranscript } from './host-transcript.js';

export type DiagnosticHostReader = (
  sessionId: string,
  timeoutMs: number,
) => Promise<HostTranscript>;

export type DiscoverySource =
  'root' | 'review_invocation' | 'review_attempt' | 'review_observation' | 'host_parent';

export interface SessionCapture {
  readonly sessionId: string;
  readonly parentSessionId: string | null;
  readonly generation: number;
  readonly captureStatus: 'captured' | 'not_captured' | 'truncated';
  readonly role: 'root' | 'reviewer' | 'continuation';
  readonly discoveredBy: readonly DiscoverySource[];
  readonly lineage: 'verified' | 'not_verified';
  readonly authority: SessionAuthorityResolution | null;
  readonly state: SessionState | null;
  readonly audit: readonly AuditEvent[];
  readonly auditValid: boolean | null;
  readonly host: HostTranscript | null;
  readonly hostRequested: boolean;
}

export interface CaptureAccumulator {
  readonly sessions: SessionCapture[];
  readonly warnings: DiagnosticWarning[];
  readonly receipts: Array<{ path: string; sha256: string; bytes: number }>;
  auditEvents: number;
  hostMessages: number;
  totalBytes: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly deadlineAt: number;
  truncated: boolean;
}

export interface SessionDiscovery {
  readonly sources: DiscoverySource[];
  readonly parentSessionId: string | null;
  readonly lineage: 'verified' | 'not_verified';
}

export interface ArtifactWriteTarget {
  readonly outputDir: string;
  readonly redactionMode: import('../../redaction/export-redaction.js').RedactionMode;
}

export function warning(
  code: string,
  message: string,
  sessionId: string | null,
  source: DiagnosticWarning['source'],
): DiagnosticWarning {
  return { code, message, sessionId, source };
}

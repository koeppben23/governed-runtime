/**
 * @module audit/timestamp-types
 * @description Re-exported timestamp assurance types and default policy constant.
 *
 * Zod schema SSOT lives in state/evidence-timestamp.ts.
 * This module re-exports the inferred TypeScript types for audit-layer consumers
 * and provides the default timestamp assurance policy constant.
 *
 * @version v1
 */

export type {
  TimestampAssuranceStatus,
  TimestampSource,
  NtpEvidence,
  TsaEvidence,
  TsaVerificationStatus,
  TimestampEvidence,
  TimestampAssuranceMode,
} from '../state/evidence-timestamp.js';

export const DEFAULT_TIMESTAMP_ASSURANCE = {
  enabled: false,
  mode: 'local_only' as const,
  strict: false,
  criticalEvents: ['decision', 'lifecycle'],
  ntpServers: ['pool.ntp.org'],
  ntpDriftThresholdMs: 30000,
  tsaTimeoutMs: 10000,
} as const;

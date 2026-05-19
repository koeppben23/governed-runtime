/**
 * @module evidence-timestamp
 * @description Zod schemas for timestamp assurance evidence on audit events.
 *
 * SSOT for all timestamp-related audit event schemas.
 * audit/timestamp-types.ts re-exports inferred types for external consumers.
 *
 * @version v1
 */

import { z } from 'zod';

export const TimestampAssuranceStatus = z.enum([
  'local',
  'ntp_checked',
  'tsa_stamped',
  'tsa_verified',
  'tsa_failed',
]);
export type TimestampAssuranceStatus = z.infer<typeof TimestampAssuranceStatus>;

export const TimestampSource = z.enum(['local_clock', 'ntp', 'tsa']);
export type TimestampSource = z.infer<typeof TimestampSource>;

export const NtpEvidenceSchema = z.object({
  offsetMs: z.number(),
  server: z.string(),
  driftWarned: z.boolean(),
});
export type NtpEvidence = z.infer<typeof NtpEvidenceSchema>;

export const TsaVerificationStatus = z.enum(['unchecked', 'valid', 'invalid']);
export type TsaVerificationStatus = z.infer<typeof TsaVerificationStatus>;

export const TsaEvidenceSchema = z.object({
  tokenDerBase64: z.string(),
  receivedAt: z.string().datetime(),
  policyOid: z.string().optional(),
  serialNumber: z.string().optional(),
  tsaTimestamp: z.string().optional(),
  signerSubject: z.string().optional(),
  verificationStatus: TsaVerificationStatus,
  verificationReason: z.string().optional(),
});
export type TsaEvidence = z.infer<typeof TsaEvidenceSchema>;

export const TimestampEvidence = z.object({
  status: TimestampAssuranceStatus,
  source: TimestampSource,
  ntp: NtpEvidenceSchema.optional(),
  tsa: TsaEvidenceSchema.optional(),
  warning: z.string().optional(),
  resolvedAt: z.string().datetime(),
});
export type TimestampEvidence = z.infer<typeof TimestampEvidence>;

export const TimestampAssuranceMode = z.enum(['local_only', 'ntp_check', 'tsa_critical']);
export type TimestampAssuranceMode = z.infer<typeof TimestampAssuranceMode>;

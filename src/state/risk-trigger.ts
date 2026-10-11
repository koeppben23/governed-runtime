/**
 * @module risk-trigger
 * @description Canonical risk-trigger taxonomy.
 *
 * A leaf module: it owns the trigger vocabulary so both the session schema and
 * the ProofGraph claim contract can share it without a module cycle.
 *
 * - {@link SpecificRiskTrigger}: an authority affected by a HIGH-RISK change.
 *   Every specific trigger detected for the current implementation requires
 *   explicit coverage by a certificate-authorized critical fact claim before
 *   final evidence approval.
 * - {@link RiskTrigger}: the full taxonomy, including `ceremony_only`, which
 *   preserves broad HIGH-RISK ceremony but never requires a claim and can never
 *   be declared as covered.
 *
 * @version v1
 */

import { z } from 'zod';

/** Specific authorities a HIGH-RISK implementation change can touch. */
export const SPECIFIC_RISK_TRIGGERS = [
  'state_integrity',
  'audit_authority',
  'identity_boundary',
  'approval_authority',
  'policy_authority',
  'migration',
  'distribution_integrity',
  'command_contract',
] as const;

export const SpecificRiskTrigger = z.enum(SPECIFIC_RISK_TRIGGERS);
export type SpecificRiskTrigger = z.infer<typeof SpecificRiskTrigger>;

/** Full trigger taxonomy: every specific trigger plus the non-requiring ceremony marker. */
export const RiskTrigger = z.enum([...SPECIFIC_RISK_TRIGGERS, 'ceremony_only']);
export type RiskTrigger = z.infer<typeof RiskTrigger>;

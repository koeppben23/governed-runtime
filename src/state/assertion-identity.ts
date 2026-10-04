/**
 * @module state/assertion-identity
 * @description Syntactic identity schemas for assertion providers, report formats,
 * and structured assertion identities.
 *
 * These are registry-free. The state layer validates only syntactic form.
 * Semantic validation (provider is registered / format is supported) lives in
 * the verification layer (registry.ts).
 *
 * @version v1
 */

import { z } from 'zod';

/** Syntactically valid provider identifier (e.g. junit, vitest, pytest). */
export const ProviderId = z.string().regex(/^[a-z][a-z0-9_]*$/);
export type ProviderId = z.infer<typeof ProviderId>;

/** Syntactically valid report format identifier (e.g. junit_xml, vitest_json). */
export const ReportFormatId = z.string().regex(/^[a-z][a-z0-9_]*$/);
export type ReportFormatId = z.infer<typeof ReportFormatId>;

/**
 * Structured assertion identity — provider-independent envelope.
 *
 * {@link providerId} identifies the assertion identity codec.
 * {@link localId} is a provider-specific canonical identifier whose format is
 * defined by the codec registered for this provider.
 *
 * Neither the state layer nor the ProofGraph evaluator interpret `localId`
 * internally. Binding and rendering consume it opaquely.
 */
export const AssertionIdentity = z
  .object({
    providerId: ProviderId,
    localId: z.string().min(1),
  })
  .strict()
  .readonly();
export type AssertionIdentity = z.infer<typeof AssertionIdentity>;

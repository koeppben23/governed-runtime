/**
 * @module identity/types
 * @description IdP types for P35a static key verification.
 */

import { z } from 'zod';

export type KeyKind = 'jwk' | 'pem';

export type KeyAlgorithm = 'RS256' | 'ES256';

export const JwkKeySchema = z.object({
  kind: z.literal('jwk'),
  kid: z.string().min(1),
  alg: z.enum(['RS256', 'ES256']),
  jwk: z.object({
    kty: z.enum(['RSA', 'EC']),
    n: z.string().optional(),
    e: z.string().optional(),
    d: z.string().optional(),
    p: z.string().optional(),
    q: z.string().optional(),
    dp: z.string().optional(),
    dq: z.string().optional(),
    qi: z.string().optional(),
    x: z.string().optional(),
    y: z.string().optional(),
    crv: z.string().optional(),
  }),
});

export const PemKeySchema = z.object({
  kind: z.literal('pem'),
  kid: z.string().min(1),
  alg: z.enum(['RS256', 'ES256']),
  pem: z.string().min(1),
});

export const SigningKeySchema = z.union([JwkKeySchema, PemKeySchema]);

export type SigningKey = z.infer<typeof SigningKeySchema>;
export type JwkKey = z.infer<typeof JwkKeySchema>;
export type PemKey = z.infer<typeof PemKeySchema>;

export const ClaimMappingSchema = z.object({
  subjectClaim: z.string().min(1).default('sub'),
  emailClaim: z.string().min(1).default('email'),
  nameClaim: z.string().min(1).default('name'),
});

export type ClaimMapping = z.infer<typeof ClaimMappingSchema>;

export const IdpConfigSchema = z.object({
  issuer: z.string().min(1),
  audience: z
    .union([z.string().min(1), z.array(z.string().min(1))])
    .transform((val) => (Array.isArray(val) ? val : [val])),
  claimMapping: ClaimMappingSchema.default({}),
  signingKeys: z.array(SigningKeySchema).min(1),
});

export type IdpConfig = z.infer<typeof IdpConfigSchema>;

export const IdentityProviderModeSchema = z.enum(['optional', 'required']);

export type IdentityProviderMode = z.infer<typeof IdentityProviderModeSchema>;

export interface VerifiedToken {
  subject: string;
  email: string | null;
  displayName: string | null;
  issuer: string;
  audience: string[];
  issuedAt: Date | null;
  notBefore: Date | null;
  expiresAt: Date;
  keyId: string;
  algorithm: string;
  rawClaims: Record<string, unknown>;
}

export interface ActorVerificationMeta {
  issuer: string;
  audience: string[];
  keyId: string;
  algorithm: string;
  verifiedAt: string;
}

export interface ResolvedIdpActor {
  id: string;
  email: string | null;
  displayName: string | null;
  source: 'oidc';
  assurance: 'idp_verified';
  verificationMeta: ActorVerificationMeta;
}

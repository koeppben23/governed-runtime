/**
 * @module identity/types
 * @description IdP types and JWKS document schemas for P35a/P35b1/P35b2
 *              static + JWKS verification.
 *
 * IdP configuration schemas (IdpConfigSchema, SigningKeySchema, etc.) are
 * owned by state/policy-idp-config.ts and re-exported here for backward
 * compatibility with identity runtime and config-layer consumers.
 *
 * JWKS document schemas (JwksDocumentSchema, JwksKeySchema) remain owned
 * by this module — they describe on-the-wire JWKS document formats,
 * not persisted policy configuration.
 */

import { z } from 'zod';

import {
  ClaimMappingSchema,
  IdpConfigSchema,
  IdentityProviderModeSchema,
  JwkKeySchema,
  JwksIdpConfigSchema,
  PemKeySchema,
  SigningKeySchema,
  StaticIdpConfigSchema,
} from '../state/policy-idp-config.js';

export {
  ClaimMappingSchema,
  IdpConfigSchema,
  IdentityProviderModeSchema,
  JwkKeySchema,
  JwksIdpConfigSchema,
  PemKeySchema,
  SigningKeySchema,
  StaticIdpConfigSchema,
};

export type KeyKind = 'jwk' | 'pem';

export type KeyAlgorithm = 'RS256' | 'ES256';

export type JwkKey = z.infer<typeof JwkKeySchema>;
export type PemKey = z.infer<typeof PemKeySchema>;
export type SigningKey = z.infer<typeof SigningKeySchema>;
export type ClaimMapping = z.infer<typeof ClaimMappingSchema>;
export type IdpConfig = z.infer<typeof IdpConfigSchema>;
export type StaticIdpConfig = z.infer<typeof StaticIdpConfigSchema>;
export type JwksIdpConfig = z.infer<typeof JwksIdpConfigSchema>;
export type IdentityProviderMode = z.infer<typeof IdentityProviderModeSchema>;

// ─── JWKS Document Schemas ────────────────────────────────────────────────────

const JwksRsaKeySchema = z
  .object({
    kid: z.string().min(1),
    alg: z.enum(['RS256', 'ES256']).optional(),
    kty: z.literal('RSA'),
    n: z.string().min(1),
    e: z.string().min(1),
  })
  .strict();

const JwksEcKeySchema = z
  .object({
    kid: z.string().min(1),
    alg: z.enum(['RS256', 'ES256']).optional(),
    kty: z.literal('EC'),
    x: z.string().min(1),
    y: z.string().min(1),
    crv: z.string().min(1),
  })
  .strict();

export const JwksKeySchema = z.union([JwksRsaKeySchema, JwksEcKeySchema]);

export const JwksDocumentSchema = z
  .object({
    keys: z.array(JwksKeySchema).min(1),
  })
  .strict();

export type JwksKey = z.infer<typeof JwksKeySchema>;
export type JwksDocument = z.infer<typeof JwksDocumentSchema>;

// ─── Interfaces ───────────────────────────────────────────────────────────────

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

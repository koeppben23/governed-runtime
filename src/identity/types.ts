/**
 * @module identity/types
 * @description IdP types for P35a/P35b1/P35b2 static + JWKS verification.
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

const IdpConfigBaseSchema = z.object({
  issuer: z.string().min(1),
  audience: z
    .union([z.string().min(1), z.array(z.string().min(1))])
    .transform((val) => (Array.isArray(val) ? val : [val])),
  claimMapping: ClaimMappingSchema.default({}),
});

export const StaticIdpConfigSchema = IdpConfigBaseSchema.extend({
  mode: z.literal('static'),
  signingKeys: z.array(SigningKeySchema).min(1),
}).strict();

export const JwksIdpConfigSchema = IdpConfigBaseSchema.extend({
  mode: z.literal('jwks'),
  jwksPath: z.string().min(1).optional(),
  jwksUri: z.string().url().optional(),
  cacheTtlSeconds: z.number().int().min(1).max(3600).default(300),
}).strict();

const IdpConfigDiscriminatedSchema = z
  .discriminatedUnion('mode', [StaticIdpConfigSchema, JwksIdpConfigSchema])
  .superRefine((value, ctx) => {
    if (value.mode !== 'jwks') return;
    const hasPath = typeof value.jwksPath === 'string' && value.jwksPath.trim().length > 0;
    const hasUri = typeof value.jwksUri === 'string' && value.jwksUri.trim().length > 0;
    if (hasPath === hasUri) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "JWKS mode requires exactly one of 'jwksPath' or 'jwksUri'",
      });
    }
  });

const IdpConfigWithCompatSchema = z.preprocess((raw) => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return raw;
  }
  const record = raw as Record<string, unknown>;
  if (record.mode === undefined && Array.isArray(record.signingKeys)) {
    return {
      ...record,
      mode: 'static',
    };
  }
  return raw;
}, IdpConfigDiscriminatedSchema);

export const IdpConfigSchema = IdpConfigWithCompatSchema;

export type IdpConfig = z.infer<typeof IdpConfigSchema>;
export type StaticIdpConfig = z.infer<typeof StaticIdpConfigSchema>;
export type JwksIdpConfig = z.infer<typeof JwksIdpConfigSchema>;

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

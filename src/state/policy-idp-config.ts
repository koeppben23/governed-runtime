/**
 * @module state/policy-idp-config
 * @description IdP configuration Zod schemas owned by the state layer.
 *
 * These schemas define the shape of persisted identity-provider configuration
 * embedded in policy snapshots (PolicySnapshotSchema → identityProvider field).
 * They are pure schema definitions with no runtime identity resolution,
 * token verification, JWKS fetching, or actor/assurance logic.
 *
 * identity/types.ts re-exports these schemas for backward compatibility
 * with non-state callers (identity runtime, config layer).
 *
 * @version v1
 */

import { z } from 'zod';

const JwkRsaSchema = z
  .object({
    kty: z.literal('RSA'),
    n: z.string().min(1),
    e: z.string().min(1),
  })
  .strict();

const JwkEcSchema = z
  .object({
    kty: z.literal('EC'),
    x: z.string().min(1),
    y: z.string().min(1),
    crv: z.string().min(1),
  })
  .strict();

const JwkFieldsSchema = z.discriminatedUnion('kty', [JwkRsaSchema, JwkEcSchema]);

export const JwkKeySchema = z
  .object({
    kind: z.literal('jwk'),
    kid: z.string().min(1),
    alg: z.enum(['RS256', 'ES256']),
    jwk: JwkFieldsSchema,
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.alg === 'RS256' && data.jwk.kty !== 'RSA') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'RS256 requires RSA key (kty=RSA)',
        path: ['alg'],
      });
    }
    if (data.alg === 'ES256' && data.jwk.kty !== 'EC') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'ES256 requires EC key (kty=EC)',
        path: ['alg'],
      });
    }
  });

export type JwkKey = z.infer<typeof JwkKeySchema>;

export const PemKeySchema = z.object({
  kind: z.literal('pem'),
  kid: z.string().min(1),
  alg: z.enum(['RS256', 'ES256']),
  pem: z.string().min(1),
});

export type PemKey = z.infer<typeof PemKeySchema>;

export const SigningKeySchema = z.union([JwkKeySchema, PemKeySchema]);

export type SigningKey = z.infer<typeof SigningKeySchema>;

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
  claimMapping: ClaimMappingSchema.default({
    subjectClaim: 'sub',
    emailClaim: 'email',
    nameClaim: 'name',
  }),
});

export const StaticIdpConfigSchema = IdpConfigBaseSchema.extend({
  mode: z.literal('static'),
  signingKeys: z.array(SigningKeySchema).min(1),
}).strict();

export type StaticIdpConfig = z.infer<typeof StaticIdpConfigSchema>;

export const JwksIdpConfigSchema = IdpConfigBaseSchema.extend({
  mode: z.literal('jwks'),
  jwksPath: z.string().min(1).optional(),
  jwksUri: z.string().url().optional(),
  cacheTtlSeconds: z.number().int().min(1).max(3600).default(300),
}).strict();

export type JwksIdpConfig = z.infer<typeof JwksIdpConfigSchema>;

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

export const IdentityProviderModeSchema = z.enum(['optional', 'required']);

export type IdentityProviderMode = z.infer<typeof IdentityProviderModeSchema>;

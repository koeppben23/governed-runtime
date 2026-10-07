/**
 * @module shared/policy-idp-config
 * @description Canonical IdP policy configuration Zod schemas.
 *
 * These schemas define the policy configuration shape shared by policy
 * resolution, persisted policy snapshots, and identity verification. They have
 * no runtime identity resolution, token verification, JWKS fetching, or
 * actor/assurance logic.
 *
 * Two schema families exist deliberately:
 * - `IdpConfigSchema` is the lenient **config input** contract: it accepts
 *   shorthand (scalar `audience`) and materializes absent defaults
 *   (`claimMapping`, jwks `cacheTtlSeconds`) at the authoring boundary.
 * - `FrozenIdpConfigSchema` is the canonical **persisted snapshot** contract:
 *   strict, no transforms and no defaults, so reading state can never rewrite
 *   historical values.
 *
 * @version v2
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

/**
 * JWKS mode requires exactly one location. Shared by the lenient input schema
 * and the frozen snapshot schema so both boundaries stay aligned.
 */
function refineJwksLocation(
  value: {
    readonly mode: 'static' | 'jwks';
    readonly jwksPath?: string | undefined;
    readonly jwksUri?: string | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (value.mode !== 'jwks') return;
  const hasPath = typeof value.jwksPath === 'string' && value.jwksPath.trim().length > 0;
  const hasUri = typeof value.jwksUri === 'string' && value.jwksUri.trim().length > 0;
  if (hasPath === hasUri) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "JWKS mode requires exactly one of 'jwksPath' or 'jwksUri'",
    });
  }
}

const IdpConfigDiscriminatedSchema = z
  .discriminatedUnion('mode', [StaticIdpConfigSchema, JwksIdpConfigSchema])
  .superRefine(refineJwksLocation);

export const IdpConfigSchema = IdpConfigDiscriminatedSchema;

export type IdpConfig = z.infer<typeof IdpConfigSchema>;

/**
 * Canonical claim mapping for persisted snapshots: every field is required and
 * no default is applied, so reading state never materializes values.
 */
const FrozenClaimMappingSchema = z
  .object({
    subjectClaim: z.string().min(1),
    emailClaim: z.string().min(1),
    nameClaim: z.string().min(1),
  })
  .strict();

const FrozenIdpConfigBaseSchema = z.object({
  issuer: z.string().min(1),
  audience: z.array(z.string().min(1)).min(1),
  claimMapping: FrozenClaimMappingSchema,
});

const FrozenStaticIdpConfigSchema = FrozenIdpConfigBaseSchema.extend({
  mode: z.literal('static'),
  signingKeys: z.array(SigningKeySchema).min(1),
}).strict();

const FrozenJwksIdpConfigSchema = FrozenIdpConfigBaseSchema.extend({
  mode: z.literal('jwks'),
  jwksPath: z.string().min(1).optional(),
  jwksUri: z.string().url().optional(),
  cacheTtlSeconds: z.number().int().min(1).max(3600),
}).strict();

/**
 * Strict canonical IdP contract for persisted policy snapshots.
 *
 * No `.default()`/`.transform()` anywhere: scalar `audience`, missing
 * `claimMapping`, and missing jwks `cacheTtlSeconds` are rejected instead of
 * being normalized on read (the hard-cut persisted-shape contract). New
 * snapshots are already canonical because the config input is parsed through
 * `IdpConfigSchema` before the snapshot is frozen.
 */
export const FrozenIdpConfigSchema = z
  .discriminatedUnion('mode', [FrozenStaticIdpConfigSchema, FrozenJwksIdpConfigSchema])
  .superRefine(refineJwksLocation);

export type FrozenIdpConfig = z.infer<typeof FrozenIdpConfigSchema>;

export const IdentityProviderModeSchema = z.enum(['optional', 'required']);

export type IdentityProviderMode = z.infer<typeof IdentityProviderModeSchema>;

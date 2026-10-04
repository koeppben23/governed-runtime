/**
 * @module integration/proofgraph/config-default-consistency
 * @description Cross-artifact structural consistency for configuration defaults.
 *
 * Encodes the config-layer contract (config/AGENTS.md): readConfig() always
 * returns a fully normalized object, every nested object has a `.default()`, and
 * those defaults are internally consistent. A drift here - a removed default, a
 * nested object that no longer normalizes, or a non-idempotent default - is the
 * "green CI but schema and runtime defaults disagree" class this detects:
 *   - defaults_parse:      a minimal config normalizes at all;
 *   - defaults_complete:   every required top-level key is present after defaulting;
 *   - defaults_idempotent: re-parsing the normalized defaults yields the same config.
 *
 * Pure and dependency-injected so it is testable with seeded inconsistencies;
 * `checkConfigDefaultConsistency` binds the real FlowGuardConfigSchema. Advisory.
 *
 * @version v1
 */

import { z } from 'zod';

import { FlowGuardConfigSchema } from '../../config/flowguard-config.js';
import { canonicalJsonStringify } from '../../shared/canonical-json.js';

/** Which config-default invariant a finding violated. */
export type ConfigDefaultRule = 'defaults_parse' | 'defaults_complete' | 'defaults_idempotent';

/** A single detected config-default inconsistency. */
export interface ConfigDefaultFinding {
  readonly rule: ConfigDefaultRule;
  readonly detail: string;
}

/** Result of a config-default-consistency evaluation. */
export interface ConfigDefaultReport {
  readonly ok: boolean;
  readonly findings: readonly ConfigDefaultFinding[];
}

/** Required top-level keys of a fully normalized FlowGuard config. */
export const CONFIG_TOP_LEVEL_KEYS = [
  'schemaVersion',
  'logging',
  'policy',
  'profile',
  'presentation',
  'host',
  'archive',
] as const;

/**
 * Evaluate config-default consistency over an injected schema (pure).
 *
 * @param schema       The config schema to check.
 * @param requiredKeys Top-level keys expected after defaulting.
 * @param minimalInput The minimal input that should normalize to full defaults.
 */
export function evaluateConfigDefaultConsistency(
  schema: z.ZodTypeAny,
  requiredKeys: readonly string[],
  minimalInput: unknown,
): ConfigDefaultReport {
  const parsed = schema.safeParse(minimalInput);
  if (!parsed.success) {
    return {
      ok: false,
      findings: [{ rule: 'defaults_parse', detail: 'a minimal config does not normalize' }],
    };
  }
  const defaults = parsed.data as Record<string, unknown>;
  const findings: ConfigDefaultFinding[] = [];
  for (const key of requiredKeys) {
    if (!(key in defaults)) {
      findings.push({ rule: 'defaults_complete', detail: `missing default for '${key}'` });
    }
  }
  const reparsed = schema.safeParse(defaults);
  if (!reparsed.success) {
    findings.push({ rule: 'defaults_idempotent', detail: 'normalized defaults do not re-parse' });
  } else if (canonicalJsonStringify(reparsed.data) !== canonicalJsonStringify(defaults)) {
    findings.push({
      rule: 'defaults_idempotent',
      detail: 're-parsing the normalized defaults changed the config',
    });
  }
  return { ok: findings.length === 0, findings };
}

/** Evaluate config-default consistency against the real FlowGuardConfigSchema. */
export function checkConfigDefaultConsistency(): ConfigDefaultReport {
  return evaluateConfigDefaultConsistency(FlowGuardConfigSchema, CONFIG_TOP_LEVEL_KEYS, {
    schemaVersion: 'v1',
  });
}

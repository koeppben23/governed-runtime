/**
 * @module integration/proofgraph/structural-provider
 * @description Structural and schema-comparison evidence providers.
 *
 * Turns the existing cross-artifact consistency checks into ProofGraph evidence
 * instead of standalone reports. Each surface is:
 *
 * - identified by a stable `surfaceId` a claim can reference;
 * - bound to a canonical digest over the covered registry/schema DATA, so a
 *   passing assertion goes STALE as soon as that surface changes;
 * - reported as a reproducible provider result with a deterministic assertion
 *   input, a source, and a result digest.
 *
 * A claim opts in via a `structural_surface` evidence reference. Claims that do
 * not reference a surface receive no structural evidence — this never invents
 * coverage.
 *
 * Advisory: these results feed the evaluator; they never gate a workflow.
 *
 * @version v1
 */

import { INSTALLED_COMMANDS } from '../installed-commands.js';
import { COMMANDS } from '../../templates/commands/index.js';
import { Command } from '../../machine/commands.js';
import { ALL_FLOWGUARD_TOOL_NAMES } from '../tool-names.js';
import { FlowGuardConfigSchema } from '../../config/flowguard-config.js';
import { canonicalJsonStringify } from '../../shared/canonical-json.js';
import { hashText } from '../../shared/hashing.js';
import type { SessionState } from '../../state/schema.js';
import type { ProofProviderResult } from '../../state/proofgraph.js';
import type { ProofProviderKind } from '../../state/proofgraph-primitives.js';
import { checkRegistrationConsistency } from './registration-consistency.js';
import {
  checkConfigDefaultConsistency,
  CONFIG_TOP_LEVEL_KEYS,
} from './config-default-consistency.js';
import { computeSurfaceDigest } from './surface-digest.js';

/** Stable identifier of the command-registration consistency surface. */
export const SURFACE_COMMAND_REGISTRATION = 'command-registration';
/** Stable identifier of the config-default consistency surface. */
export const SURFACE_CONFIG_DEFAULTS = 'config-defaults';

/** Provider version stamped on structural/schema results. */
export const STRUCTURAL_PROVIDER_VERSION = 'structural.v1';

/** One evaluated structural surface: its digest, verdict, and reproducible inputs. */
export interface StructuralSurfaceEvaluation {
  readonly surfaceId: string;
  readonly providerKind: ProofProviderKind;
  readonly providerId: string;
  /** Deterministic assertion input describing what was checked. */
  readonly assertion: string;
  /** Descriptive module locations constituting the surface. */
  readonly locations: readonly string[];
  /** Canonical digest over the covered surface data. */
  readonly digest: string;
  /** Whether the consistency assertion held. */
  readonly ok: boolean;
  /** SHA-256 over the canonical report (the provider output). */
  readonly resultDigest: string;
  /** Compact human-readable verdict detail. */
  readonly detail: string;
}

function evaluateCommandRegistrationSurface(): StructuralSurfaceEvaluation {
  const report = checkRegistrationConsistency();
  // The surface is the registry CONTENT the assertion reads.
  const surfaceData = {
    installedCommands: INSTALLED_COMMANDS.map((c) => ({
      invocation: c.invocation,
      templateFile: c.templateFile,
      toolName: c.target.toolName,
      workflowCommand: c.target.workflowCommand ?? null,
    })).sort((a, b) => (a.invocation < b.invocation ? -1 : 1)),
    templateFiles: Object.keys(COMMANDS).sort(),
    toolNames: [...ALL_FLOWGUARD_TOOL_NAMES].sort(),
    workflowCommands: Object.values(Command).sort(),
  };
  return {
    surfaceId: SURFACE_COMMAND_REGISTRATION,
    providerKind: 'structural_assertion',
    providerId: 'registration-consistency',
    assertion:
      'every installed command has an installed template body, a registered target tool, and a valid workflow command',
    locations: [
      'src/integration/installed-commands.ts',
      'src/templates/commands/index.ts',
      'src/machine/commands.ts',
      'src/integration/tool-names.ts',
    ],
    digest: computeSurfaceDigest(surfaceData),
    ok: report.ok,
    resultDigest: hashText(canonicalJsonStringify(report)),
    detail: report.ok
      ? `${report.checkedCommands} commands consistent`
      : `${report.findings.length} registration inconsistencies`,
  };
}

function evaluateConfigDefaultsSurface(): StructuralSurfaceEvaluation {
  const report = checkConfigDefaultConsistency();
  const parsed = FlowGuardConfigSchema.safeParse({ schemaVersion: 'v1' });
  // The surface is the normalized default configuration the assertion compares.
  const surfaceData = {
    requiredKeys: [...CONFIG_TOP_LEVEL_KEYS].sort(),
    defaults: parsed.success ? parsed.data : null,
  };
  return {
    surfaceId: SURFACE_CONFIG_DEFAULTS,
    providerKind: 'schema_compare',
    providerId: 'config-default-consistency',
    assertion:
      'a minimal config normalizes, every required top-level default is present, and re-parsing the defaults is idempotent',
    locations: ['src/config/flowguard-config.ts'],
    digest: computeSurfaceDigest(surfaceData),
    ok: report.ok,
    resultDigest: hashText(canonicalJsonStringify(report)),
    detail: report.ok
      ? 'config defaults consistent'
      : `${report.findings.length} default inconsistencies`,
  };
}

/** Evaluate every structural/schema surface against the live registries. */
export function evaluateStructuralSurfaces(): StructuralSurfaceEvaluation[] {
  return [evaluateCommandRegistrationSurface(), evaluateConfigDefaultsSurface()];
}

/** Map of surfaceId -> current digest, for evaluator freshness resolution. */
export function surfaceDigestMap(
  evaluations: readonly StructuralSurfaceEvaluation[],
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const e of evaluations) map[e.surfaceId] = e.digest;
  return map;
}

/**
 * Bind evaluated structural surfaces to the claims that reference them.
 *
 * A claim referencing an unknown surface yields an explicit `unavailable`
 * result (surfaced as NOT_VERIFIED) rather than silently no evidence.
 *
 * @param state       Session state (source of contract claims).
 * @param evaluations Evaluated structural surfaces.
 * @param evaluatedAt ISO-8601 timestamp used for `unavailable` results.
 */
export function bindStructuralEvidence(
  state: SessionState,
  evaluations: readonly StructuralSurfaceEvaluation[],
  evaluatedAt: string,
): ProofProviderResult[] {
  const bySurface = new Map(evaluations.map((e) => [e.surfaceId, e]));
  const results: ProofProviderResult[] = [];
  for (const claim of state.proofContract?.claims ?? []) {
    for (const ref of claim.evidenceRefs) {
      if (ref.kind !== 'structural_surface') continue;
      const evaluation = bySurface.get(ref.surfaceId);
      if (evaluation === undefined) {
        results.push({
          claimId: claim.claimId,
          providerKind: 'structural_assertion',
          providerId: 'structural-surface',
          providerVersion: STRUCTURAL_PROVIDER_VERSION,
          input: {},
          status: 'unavailable',
          executedAt: evaluatedAt,
          detail: `unknown structural surface: ${ref.surfaceId}`,
        });
        continue;
      }
      results.push({
        claimId: claim.claimId,
        providerKind: evaluation.providerKind,
        providerId: evaluation.providerId,
        providerVersion: STRUCTURAL_PROVIDER_VERSION,
        input: { assertion: evaluation.assertion },
        source: {
          location: `structural-surface:${evaluation.surfaceId}`,
          stableId: evaluation.surfaceId,
        },
        binding: {
          kind: 'surface_set',
          surfaceId: evaluation.surfaceId,
          digest: evaluation.digest,
          locations: [...evaluation.locations],
        },
        status: evaluation.ok ? 'pass' : 'fail',
        resultDigest: evaluation.resultDigest,
        executedAt: evaluatedAt,
        detail: evaluation.detail,
      });
    }
  }
  return results;
}

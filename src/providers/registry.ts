/**
 * @module providers/registry
 * @description Central provider registry — single derived authority.
 *
 * All lookups (PARSER_BY_FORMAT, ASSERTION_CODEC_BY_PROVIDER,
 * FORMATS_BY_PROVIDER, ASSERTION_FORMATS_BY_PROVIDER, DESCRIPTOR_BY_PROVIDER,
 * ASSERTION_PROFILES, DESCRIPTOR_BY_DETECTION) are derived from
 * ASSERTION_PROVIDER_EXTENSIONS. No hand-maintained parallel maps.
 *
 * @version v1
 */

import type { ProviderId, ReportFormatId } from '../state/assertion-identity.js';
import type {
  AssertionReportParser,
  AssertionIdentityCodec,
} from '../verification/assertion-parsers/types.js';
import type {
  AssertionProviderExtension,
  ExecutionProfile,
  DetectionId,
  ProviderManifest,
  RuntimeRequirement,
  ScriptSignature,
} from './contract.js';
import type { AssertionReportSpec } from '../state/discovery-schemas.js';

// ─── Extension Array ─────────────────────────────────────────────────────────

import { junitProvider } from './junit/provider.js';
import { vitestProvider } from './vitest/provider.js';
import { jestProvider } from './jest/provider.js';
import { pytestProvider } from './pytest/provider.js';
import { goTestProvider } from './go-test/provider.js';

export const ASSERTION_PROVIDER_EXTENSIONS: readonly AssertionProviderExtension[] = [
  junitProvider,
  vitestProvider,
  jestProvider,
  pytestProvider,
  goTestProvider,
];

// ─── Registry Output ─────────────────────────────────────────────────────────

export interface ProviderRegistry {
  readonly extensions: readonly AssertionProviderExtension[];
  readonly parserByFormat: ReadonlyMap<ReportFormatId, AssertionReportParser>;
  readonly codecByProvider: ReadonlyMap<ProviderId, AssertionIdentityCodec>;
  readonly formatsByProvider: ReadonlyMap<ProviderId, ReadonlySet<ReportFormatId>>;
  readonly assertionFormatsByProvider: ReadonlyMap<ProviderId, ReadonlySet<ReportFormatId>>;
  readonly aggregateFormatsByProvider: ReadonlyMap<ProviderId, ReadonlySet<ReportFormatId>>;
  readonly descriptorByProvider: ReadonlyMap<ProviderId, ProviderManifest>;
  readonly descriptorByDetection: ReadonlyMap<DetectionId, ProviderManifest>;
  readonly profiles: readonly ExecutionProfile[];
  readonly profilesByProvider: ReadonlyMap<ProviderId, readonly ExecutionProfile[]>;
  readonly runtimeRequirementsByProvider: ReadonlyMap<ProviderId, readonly RuntimeRequirement[]>;
  readonly scriptSignaturesByProvider: ReadonlyMap<ProviderId, readonly ScriptSignature[]>;
  readonly reportTemplatesByProvider: ReadonlyMap<ProviderId, AssertionReportSpec | undefined>;
  readonly profilesById: ReadonlyMap<string, ExecutionProfile>;
}

export function buildProviderRegistry(
  extensions: readonly AssertionProviderExtension[],
): ProviderRegistry {
  const parserByFormat = new Map<ReportFormatId, AssertionReportParser>();
  const codecByProvider = new Map<ProviderId, AssertionIdentityCodec>();
  const formatsByProvider = new Map<ProviderId, Set<ReportFormatId>>();
  const assertionFormatsByProvider = new Map<ProviderId, Set<ReportFormatId>>();
  const aggregateFormatsByProvider = new Map<ProviderId, Set<ReportFormatId>>();
  const descriptorByProvider = new Map<ProviderId, ProviderManifest>();
  const descriptorByDetection = new Map<DetectionId, ProviderManifest>();
  const profiles: ExecutionProfile[] = [];
  const profilesByProvider = new Map<ProviderId, ExecutionProfile[]>();
  const runtimeRequirementsByProvider = new Map<ProviderId, readonly RuntimeRequirement[]>();
  const scriptSignaturesByProvider = new Map<ProviderId, readonly ScriptSignature[]>();
  const reportTemplatesByProvider = new Map<ProviderId, AssertionReportSpec | undefined>();

  for (const ext of extensions) {
    const { manifest, discovery, verification } = ext;
    const pid = manifest.providerId;

    descriptorByProvider.set(pid, manifest);

    for (const detId of discovery.detectionIds) {
      descriptorByDetection.set(detId, manifest);
    }

    if (discovery.scriptSignatures) {
      scriptSignaturesByProvider.set(pid, discovery.scriptSignatures);
    }

    if (discovery.runtimeRequirements) {
      runtimeRequirementsByProvider.set(pid, discovery.runtimeRequirements);
    }

    if (discovery.assertionReportTemplate) {
      reportTemplatesByProvider.set(pid, discovery.assertionReportTemplate);
    }

    for (const fmt of verification.formats) {
      parserByFormat.set(fmt.format, fmt.parser);

      const existing = formatsByProvider.get(pid) ?? new Set();
      existing.add(fmt.format);
      formatsByProvider.set(pid, existing);

      if (fmt.bindingCapability === 'assertion') {
        const bindingSet = assertionFormatsByProvider.get(pid) ?? new Set();
        bindingSet.add(fmt.format);
        assertionFormatsByProvider.set(pid, bindingSet);
      }
      if (fmt.bindingCapability === 'aggregate') {
        const bindingSet = aggregateFormatsByProvider.get(pid) ?? new Set();
        bindingSet.add(fmt.format);
        aggregateFormatsByProvider.set(pid, bindingSet);
      }
    }

    if (verification.identityCodec) {
      codecByProvider.set(pid, verification.identityCodec);
    }

    for (const profile of discovery.executionProfiles) {
      profiles.push(profile);
      const existing = profilesByProvider.get(pid) ?? [];
      existing.push(profile);
      profilesByProvider.set(pid, existing);
    }
  }

  profiles.sort((a, b) => a.priority - b.priority);

  const profilesById = new Map<string, ExecutionProfile>();
  for (const p of profiles) {
    profilesById.set(p.profileId, p);
  }

  return {
    extensions,
    parserByFormat,
    codecByProvider,
    formatsByProvider: new Map(
      [...formatsByProvider].map(([k, v]) => [k, v as ReadonlySet<ReportFormatId>]),
    ),
    assertionFormatsByProvider: new Map(
      [...assertionFormatsByProvider].map(([k, v]) => [k, v as ReadonlySet<ReportFormatId>]),
    ),
    aggregateFormatsByProvider: new Map(
      [...aggregateFormatsByProvider].map(([k, v]) => [k, v as ReadonlySet<ReportFormatId>]),
    ),
    descriptorByProvider,
    descriptorByDetection,
    profiles,
    profilesByProvider: new Map(
      [...profilesByProvider].map(([k, v]) => [k, v as readonly ExecutionProfile[]]),
    ),
    runtimeRequirementsByProvider,
    scriptSignaturesByProvider,
    reportTemplatesByProvider,
    profilesById,
  };
}

// ─── Singleton Default Registry ──────────────────────────────────────────────

export const DEFAULT_REGISTRY = buildProviderRegistry(ASSERTION_PROVIDER_EXTENSIONS);

// Re-export contract types for consumers
export type {
  ScriptSignature,
  RuntimeRequirement,
  ExecutionProfile,
  ExecutionSubjectResolution,
  PlannerContext,
  ProviderManifest,
  DetectionId,
  AssertionProviderExtension,
} from './contract.js';
export const PARSER_BY_FORMAT = DEFAULT_REGISTRY.parserByFormat;
export const ASSERTION_CODEC_BY_PROVIDER = DEFAULT_REGISTRY.codecByProvider;
export const FORMATS_BY_PROVIDER = DEFAULT_REGISTRY.formatsByProvider;
export const ASSERTION_FORMATS_BY_PROVIDER = DEFAULT_REGISTRY.assertionFormatsByProvider;
/** Provider-neutral aggregate capability. */
export const AGGREGATE_FORMATS_BY_PROVIDER = DEFAULT_REGISTRY.aggregateFormatsByProvider;
export const DESCRIPTOR_BY_PROVIDER = DEFAULT_REGISTRY.descriptorByProvider;
export const DESCRIPTOR_BY_DETECTION = DEFAULT_REGISTRY.descriptorByDetection;
export const ASSERTION_PROFILES = DEFAULT_REGISTRY.profiles;
export const PROFILE_BY_ID = DEFAULT_REGISTRY.profilesById;
export const REPORT_TEMPLATES_BY_PROVIDER = DEFAULT_REGISTRY.reportTemplatesByProvider;
export const SCRIPT_SIGNATURES_BY_PROVIDER = DEFAULT_REGISTRY.scriptSignaturesByProvider;
export const RUNTIME_REQUIREMENTS_BY_PROVIDER = DEFAULT_REGISTRY.runtimeRequirementsByProvider;

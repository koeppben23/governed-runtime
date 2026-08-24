/**
 * @module integration/provider-capability-resolution
 * @description Laufzeit-Projektion der Assertion-Provider-Capabilities aus
 * erkanntem Stack und tatsächlich geplanten VerificationCandidates.
 *
 * Importiert aus Discovery (Katalog) und Verification (Registry) — nur im
 * Integration-Layer erlaubt.
 *
 * @version v2
 */

import type { DetectedStack, VerificationCandidate } from '../state/discovery-schemas.js';
import type { ProviderId, ReportFormatId } from '../state/assertion-identity.js';
import { ASSERTION_PROVIDER_EXTENSIONS, DESCRIPTOR_BY_DETECTION } from '../providers/registry.js';
import {
  ASSERTION_CODEC_BY_PROVIDER,
  ASSERTION_FORMATS_BY_PROVIDER,
} from '../providers/registry.js';
import type {
  ResolvedVerificationCandidate,
  RuntimeStatus,
} from './verification-runtime-resolution.js';

// ─── Public Types ────────────────────────────────────────────────────────────

export interface ResolvedProviderCapability {
  providerId: ProviderId;
  label: string;

  detection: {
    status: 'detected' | 'not_detected';
    evidence: readonly string[];
  };

  assertionBinding: {
    status: 'available' | 'unsupported';
    format?: ReportFormatId;
  };

  candidate: {
    status: 'available' | 'unavailable';
    format?: ReportFormatId;
    source?: string;
    reason?: 'no_structured_candidate' | 'format_not_binding_capable';
  };

  runtime: {
    status: RuntimeStatus;
  };
}

// ─── Resolution ──────────────────────────────────────────────────────────────

function buildDetectionMap(detectedStack: DetectedStack | undefined): Map<ProviderId, string[]> {
  const map = new Map<ProviderId, string[]>();
  for (const item of detectedStack?.items ?? []) {
    const detId = `${item.kind}:${item.id}` as const;
    const desc = DESCRIPTOR_BY_DETECTION.get(detId);
    if (!desc) continue;
    const entry = item.evidence ? `${detId} via ${item.evidence}` : detId;
    const existing = map.get(desc.providerId);
    if (existing) {
      existing.push(entry);
    } else {
      map.set(desc.providerId, [entry]);
    }
  }
  return map;
}

type CandidateInfo = {
  candidate: VerificationCandidate;
  formatId: ReportFormatId;
  bindingCapable: boolean;
};

function buildCandidateMap(
  candidates: readonly VerificationCandidate[] | undefined,
): Map<ProviderId, CandidateInfo> {
  const map = new Map<ProviderId, CandidateInfo>();
  for (const c of candidates ?? []) {
    if (c.assertionCapability !== 'structured') continue;
    const report = c.assertionReport;
    if (!report || !report.providerId) continue;
    const formatId = report.format;
    if (!formatId) continue;

    const bindingFormats = ASSERTION_FORMATS_BY_PROVIDER.get(report.providerId);
    const supported = bindingFormats?.has(formatId) === true;
    // First candidate wins; later binding-capable candidate upgrades an
    // incompatible earlier pick. If multiple binding-capable candidates
    // exist for the same provider, the first one wins (stable input order).
    const existing = map.get(report.providerId);

    if (!existing || (!existing.bindingCapable && supported)) {
      map.set(report.providerId, { candidate: c, formatId, bindingCapable: supported });
    }
  }
  return map;
}

function resolveCandidate(
  info: CandidateInfo | undefined,
  bindingFormats: ReadonlySet<ReportFormatId> | undefined,
): ResolvedProviderCapability['candidate'] {
  if (!info) return { status: 'unavailable', reason: 'no_structured_candidate' };
  const isBinding = bindingFormats?.has(info.formatId) === true;
  if (!isBinding) {
    return {
      status: 'unavailable',
      format: info.formatId,
      reason: 'format_not_binding_capable',
    };
  }
  return {
    status: 'available',
    format: info.formatId,
    source: info.candidate.source,
  };
}

export function resolveProviderCapabilities(
  detectedStack: DetectedStack | undefined,
  verificationCandidates: readonly VerificationCandidate[] | undefined,
  runtimeCandidates?: readonly ResolvedVerificationCandidate[] | undefined,
): ResolvedProviderCapability[] {
  const detectionMap = buildDetectionMap(detectedStack);
  const candidateMap = buildCandidateMap(verificationCandidates);
  const runtimeByProvider = buildRuntimeMap(runtimeCandidates, candidateMap);
  const results: ResolvedProviderCapability[] = [];

  for (const ext of ASSERTION_PROVIDER_EXTENSIONS) {
    const pid = ext.manifest.providerId;
    const evidence = detectionMap.get(pid) ?? [];
    const codec = ASSERTION_CODEC_BY_PROVIDER.get(pid);
    const bindingFormats = ASSERTION_FORMATS_BY_PROVIDER.get(pid);
    const preferredFormat = ext.verification.formats.find(
      (f) => f.bindingCapability === 'assertion',
    )?.format;
    const bindingAvailable =
      codec !== undefined &&
      preferredFormat !== undefined &&
      bindingFormats?.has(preferredFormat) === true;

    results.push({
      providerId: pid,
      label: ext.manifest.label,
      detection: {
        status: evidence.length > 0 ? 'detected' : 'not_detected',
        evidence,
      },
      assertionBinding: {
        status: bindingAvailable ? 'available' : 'unsupported',
        format: bindingAvailable ? preferredFormat : undefined,
      },
      candidate: resolveCandidate(candidateMap.get(pid), bindingFormats),
      runtime: {
        status: runtimeByProvider.get(pid) ?? 'unknown',
      },
    });
  }

  return results;
}

function buildRuntimeMap(
  runtimeCandidates: readonly ResolvedVerificationCandidate[] | undefined,
  candidateMap: ReadonlyMap<ProviderId, CandidateInfo>,
): Map<ProviderId, RuntimeStatus> {
  const map = new Map<ProviderId, RuntimeStatus>();
  for (const rc of runtimeCandidates ?? []) {
    if (rc.candidate.assertionCapability !== 'structured') continue;
    const providerId = rc.candidate.assertionReport.providerId;
    if (!providerId) continue;
    const selected = candidateMap.get(providerId)?.candidate;
    if (selected && candidateIdentity(selected) === candidateIdentity(rc.candidate)) {
      map.set(providerId, rc.runtime.status);
    }
  }
  return map;
}

function candidateIdentity(candidate: VerificationCandidate): string {
  return candidate.candidateId ?? `${candidate.kind}:${candidate.command}:${candidate.source}`;
}

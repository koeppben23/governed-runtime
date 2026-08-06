/**
 * @module integration/provider-capability-resolution
 * @description Laufzeit-Projektion der Assertion-Provider-Capabilities aus
 * erkanntem Stack und tatsächlich geplanten VerificationCandidates.
 *
 * Importiert aus Discovery (Katalog) und Verification (Registry) — nur im
 * Integration-Layer erlaubt.
 *
 * @version v1
 */

import type { DetectedStack, VerificationCandidate } from '../state/discovery-schemas.js';
import type { ProviderId, ReportFormatId } from '../state/assertion-identity.js';
import {
  PROVIDER_DESCRIPTORS,
  DESCRIPTOR_BY_DETECTION,
} from '../discovery/assertion-provider-catalog.js';
import {
  ASSERTION_CODEC_BY_PROVIDER,
  ASSERTION_FORMATS_BY_PROVIDER,
} from '../verification/assertion-parsers/registry.js';

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

type CandidateInfo = { candidate: VerificationCandidate; formatId: ReportFormatId };

function buildCandidateMap(
  candidates: readonly VerificationCandidate[] | undefined,
): Map<ProviderId, CandidateInfo> {
  const map = new Map<ProviderId, CandidateInfo>();
  for (const c of candidates ?? []) {
    if (c.assertionCapability !== 'structured') continue;
    const report = (c as { assertionReport?: { providerId?: ProviderId; format?: ReportFormatId } })
      .assertionReport;
    if (!report?.providerId) continue;
    const formatId = report.format;
    if (!formatId) continue;
    if (!map.has(report.providerId)) {
      map.set(report.providerId, { candidate: c, formatId });
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
): ResolvedProviderCapability[] {
  const detectionMap = buildDetectionMap(detectedStack);
  const candidateMap = buildCandidateMap(verificationCandidates);
  const results: ResolvedProviderCapability[] = [];

  for (const desc of PROVIDER_DESCRIPTORS) {
    const evidence = detectionMap.get(desc.providerId) ?? [];
    const codec = ASSERTION_CODEC_BY_PROVIDER.get(desc.providerId);
    const bindingFormats = ASSERTION_FORMATS_BY_PROVIDER.get(desc.providerId);
    const bindingAvailable =
      codec !== undefined && bindingFormats?.has(desc.preferredAssertionFormat) === true;

    results.push({
      providerId: desc.providerId,
      label: desc.label,
      detection: {
        status: evidence.length > 0 ? 'detected' : 'not_detected',
        evidence,
      },
      assertionBinding: {
        status: bindingAvailable ? 'available' : 'unsupported',
        format: bindingAvailable ? desc.preferredAssertionFormat : undefined,
      },
      candidate: resolveCandidate(candidateMap.get(desc.providerId), bindingFormats),
    });
  }

  return results;
}

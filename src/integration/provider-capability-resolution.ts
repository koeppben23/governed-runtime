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
import type { ProviderId } from '../state/assertion-identity.js';
import { DESCRIPTOR_BY_DETECTION } from '../discovery/assertion-provider-catalog.js';
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
    format?: string;
  };

  candidate: {
    status: 'available' | 'unavailable';
    source?: string;
  };
}

// ─── Resolution ──────────────────────────────────────────────────────────────

function buildDetectionMap(detectedStack: DetectedStack | undefined): Map<ProviderId, string[]> {
  const map = new Map<ProviderId, string[]>();
  for (const item of detectedStack?.items ?? []) {
    const detId = `${item.kind}:${item.id}` as const;
    const desc = DESCRIPTOR_BY_DETECTION.get(detId);
    if (!desc) continue;
    const existing = map.get(desc.providerId);
    if (existing) {
      existing.push(detId);
    } else {
      map.set(desc.providerId, [detId]);
    }
  }
  return map;
}

function buildCandidateMap(
  candidates: readonly VerificationCandidate[] | undefined,
): Map<ProviderId, VerificationCandidate> {
  const map = new Map<ProviderId, VerificationCandidate>();
  for (const c of candidates ?? []) {
    if (c.assertionCapability !== 'structured') continue;
    const report = (c as { assertionReport?: { providerId?: ProviderId } }).assertionReport;
    if (report?.providerId && !map.has(report.providerId)) {
      map.set(report.providerId, c);
    }
  }
  return map;
}

export function resolveProviderCapabilities(
  detectedStack: DetectedStack | undefined,
  verificationCandidates: readonly VerificationCandidate[] | undefined,
): ResolvedProviderCapability[] {
  const detectionMap = buildDetectionMap(detectedStack);
  const candidateMap = buildCandidateMap(verificationCandidates);
  const results: ResolvedProviderCapability[] = [];

  for (const desc of DESCRIPTOR_BY_DETECTION.values()) {
    const evidence = detectionMap.get(desc.providerId) ?? [];
    const codec = ASSERTION_CODEC_BY_PROVIDER.get(desc.providerId);
    const bindingFormats = ASSERTION_FORMATS_BY_PROVIDER.get(desc.providerId);
    const bindingAvailable =
      codec !== undefined && bindingFormats?.has(desc.preferredAssertionFormat) === true;
    const matchingCandidate = candidateMap.get(desc.providerId);

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
      candidate: {
        status: matchingCandidate ? 'available' : 'unavailable',
        source: matchingCandidate?.source,
      },
    });
  }

  return results;
}

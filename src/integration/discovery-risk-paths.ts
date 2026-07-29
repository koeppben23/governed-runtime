/**
 * @module integration/discovery-risk-paths
 * @description Canonical extractor of risk-relevant repo paths from a persisted
 * `DiscoveryResult`, for deterministic challenge classification of artifacts that
 * carry no diff of their own (notably ADRs).
 *
 * This is NOT the `implementation-guidance` projection: that projection is task-
 * text filtered and lossy (it drops surfaces not corroborated by ticket terms) and
 * returns labelled items, not a path set. This function returns the FULL set of
 * risk-surface repo paths so `assessMinimumTaskClass` can classify them. It is the
 * single source of "which paths represent the repository's detected risk surface".
 *
 * Pure and null-safe: a missing/empty discovery yields an empty path list, which
 * classifies as TRIVIAL — never a block.
 */

import type { DiscoveryResult } from '../discovery/types.js';

/**
 * Repo-relative paths that constitute the repository's detected risk surfaces:
 * API / persistence / CI-CD / security surface evidence files, plus semantic
 * code-surface signal locations (endpoints, auth boundaries, data access,
 * integrations). Deduplicated; order-stable (sorted).
 */
export function discoveryRiskPaths(discovery: DiscoveryResult | null | undefined): string[] {
  if (!discovery) return [];
  const paths = new Set<string>();

  const surfaces = discovery.surfaces;
  for (const group of [surfaces.api, surfaces.persistence, surfaces.cicd, surfaces.security]) {
    for (const surface of group) {
      for (const evidence of surface.evidence) {
        if (evidence.length > 0) paths.add(evidence);
      }
    }
  }

  const code = discovery.codeSurfaces;
  if (code) {
    for (const group of [code.endpoints, code.authBoundaries, code.dataAccess, code.integrations]) {
      for (const signal of group) {
        if (signal.location.length > 0) paths.add(signal.location);
      }
    }
  }

  return [...paths].sort();
}

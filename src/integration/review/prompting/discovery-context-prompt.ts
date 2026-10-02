/**
 * @module integration/review/discovery-context-prompt
 * @description Pure bounded Discovery context formatter for reviewer prompts.
 *
 * The formatter is deterministic and performs no I/O. It renders advisory
 * falsification evidence only; ReviewFindings plus obligation binding remain
 * the review authority.
 */

import type { RepositoryDiscoverySnapshot } from '../../../state/evidence.js';

function ensureNotVerified(value: string): string {
  return value.includes('NOT_VERIFIED') ? value : `NOT_VERIFIED: ${value}`;
}

/**
 * Render the attempt-bound repository Discovery snapshot into the reviewer
 * prompt. This is the canonical envelope for standalone repository reviews:
 * the host supplied the snapshot below; the reviewer MUST inspect its health
 * and drift status before repository-dependent claims, and mark anything that
 * cannot be correlated NOT_VERIFIED.
 */
export function buildRepositoryDiscoverySnapshotSection(
  snapshot: RepositoryDiscoverySnapshot,
): string {
  const lines: string[] = [
    '## Repository Discovery Context (advisory, host-observed)',
    '',
    '## Repository Discovery Contract',
    '',
    'The host supplied the repository Discovery snapshot below.',
    '',
    'You MUST inspect its health and drift status before making repository-dependent',
    'quality claims.',
    '',
    'If health is unavailable/degraded, or drift is unavailable/drifted, mark any claim',
    'that depends on that Discovery information NOT_VERIFIED.',
    '',
    'Discovery is advisory investigation context. It does not redefine the frozen',
    'review subject, review scope, finding anchors, or verdict authority.',
    '',
    `- observedAt: ${snapshot.observedAt}`,
    `- discoveryDigest: ${snapshot.discoveryDigest ?? 'unknown'}`,
    '',
  ];
  appendSnapshotHealth(lines, snapshot);
  appendSnapshotDrift(lines, snapshot);
  appendSnapshotStack(lines, snapshot);
  appendSnapshotCandidates(lines, snapshot);
  if (snapshot.riskSurfaces.length > 0) {
    lines.push('### Risk Surfaces');
    for (const surface of snapshot.riskSurfaces) lines.push(`- ${surface}`);
    lines.push('');
  }
  for (const warning of snapshot.warnings) {
    lines.push(`- warning: ${warning.code}: ${warning.message}`);
  }
  for (const item of snapshot.notVerified) {
    lines.push(`- ${ensureNotVerified(item)}`);
  }
  return trimTrailingBlanks(lines).join('\n');
}

function appendSnapshotHealth(lines: string[], snapshot: RepositoryDiscoverySnapshot): void {
  lines.push(
    '### Health',
    `- status: ${snapshot.health.status}`,
    `- healthy: ${String(snapshot.health.healthy)}`,
  );
  if (snapshot.health.failedCollectorNames.length > 0) {
    lines.push(`- failedCollectors: ${snapshot.health.failedCollectorNames.join(', ')}`);
  }
  if (snapshot.health.hasBudgetExhaustion) {
    lines.push('- warning: code-surface analysis exhausted its budget');
  }
  if (snapshot.health.ageWarning) lines.push(`- warning: ${snapshot.health.ageWarning}`);
  for (const item of snapshot.health.notVerified) {
    lines.push(`- ${ensureNotVerified(item)}`);
  }
  if (snapshot.health.status !== 'available' || !snapshot.health.healthy) {
    lines.push(
      '- NOT_VERIFIED: Discovery is degraded or unavailable; stack, file, and verification guidance may be incomplete.',
    );
  }
  lines.push('');
}

function appendSnapshotDrift(lines: string[], snapshot: RepositoryDiscoverySnapshot): void {
  lines.push('### Drift', `- status: ${snapshot.drift.status}`);
  if (snapshot.drift.currentDigest) lines.push(`- currentDigest: ${snapshot.drift.currentDigest}`);
  if (snapshot.drift.persistedDigest) {
    lines.push(`- persistedDigest: ${snapshot.drift.persistedDigest}`);
  }
  if (snapshot.drift.changedContributorNames.length > 0) {
    lines.push(`- changedContributors: ${snapshot.drift.changedContributorNames.join(', ')}`);
  }
  for (const item of snapshot.drift.notVerified) {
    lines.push(`- ${ensureNotVerified(item)}`);
  }
  if (snapshot.drift.status === 'not_assessed' || snapshot.drift.status === 'unavailable') {
    lines.push(
      '- NOT_VERIFIED: Discovery drift was not assessed; mark drift-dependent claims NOT_VERIFIED.',
    );
  }
  lines.push('');
}

function appendSnapshotStack(lines: string[], snapshot: RepositoryDiscoverySnapshot): void {
  lines.push('### Detected Stack');
  const stack = snapshot.detectedStack;
  if (!stack) {
    lines.push('- none detected or unavailable', '');
    return;
  }
  lines.push(`- summary: ${stack.summary || 'none'}`);
  for (const item of stack.items.slice(0, 8)) {
    const version = item.version ? `=${item.version}` : '';
    const evidence = item.evidence ? ` (evidence: ${item.evidence})` : '';
    lines.push(`- ${item.kind}: ${item.id}${version}${evidence}`);
  }
  lines.push('');
}

function appendSnapshotCandidates(lines: string[], snapshot: RepositoryDiscoverySnapshot): void {
  lines.push('### Verification Candidates');
  if (snapshot.verificationCandidates.length === 0) {
    lines.push(
      '- none',
      '- NOT_VERIFIED: No repo-native verification candidates are available; do not invent them.',
      '',
    );
    return;
  }
  lines.push('- advisory only; these are not executed checks');
  for (const candidate of snapshot.verificationCandidates.slice(0, 6)) {
    const identity = candidate.candidateId ? `; candidateId: ${candidate.candidateId}` : '';
    lines.push(
      `- ${candidate.kind}: ${candidate.command} (source: ${candidate.source}; confidence: ${candidate.confidence}${identity})`,
    );
  }
  lines.push('');
}

function trimTrailingBlanks(lines: string[]): string[] {
  const next = [...lines];
  while (next[next.length - 1] === '') next.pop();
  return next;
}

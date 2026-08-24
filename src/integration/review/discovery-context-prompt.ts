/**
 * @module integration/review/discovery-context-prompt
 * @description Pure bounded Discovery context formatter for reviewer prompts.
 *
 * The formatter is deterministic and performs no I/O. It renders advisory
 * falsification evidence only; ReviewFindings plus obligation binding remain
 * the review authority.
 */

import type { DiscoveryHealthProjection } from '../../discovery/discovery-health.js';
import type { DiscoveryDriftStatusProjection } from '../discovery-drift-status.js';
import type {
  ImplementationGuidanceItem,
  ImplementationGuidanceProjection,
} from '../implementation-guidance.js';
import type { DetectedStack, VerificationCandidates } from '../../state/discovery-schemas.js';
import type { RepositoryDiscoverySnapshot } from '../../state/evidence.js';

export interface DiscoveryContextLimits {
  readonly stackItems: number;
  readonly verificationCandidates: number;
  readonly relevantFiles: number;
  readonly surfaces: number;
  readonly modules: number;
  readonly contracts: number;
  readonly riskHotspots: number;
  readonly tests: number;
  readonly warnings: number;
  readonly notVerified: number;
  readonly changedContributors: number;
}

export interface DiscoveryReviewContext {
  readonly health?: DiscoveryHealthProjection | null;
  readonly drift?: DiscoveryDriftStatusProjection | null;
  readonly detectedStack?: DetectedStack | null;
  readonly verificationCandidates?: VerificationCandidates;
  readonly implementationGuidance?: Pick<
    ImplementationGuidanceProjection,
    | 'confidence'
    | 'warnings'
    | 'notVerified'
    | 'relevantFiles'
    | 'surfaces'
    | 'modules'
    | 'contracts'
    | 'riskHotspots'
    | 'tests'
  > | null;
  readonly notVerified?: readonly string[];
  readonly limits?: Partial<DiscoveryContextLimits>;
}

const DEFAULT_LIMITS: DiscoveryContextLimits = {
  stackItems: 8,
  verificationCandidates: 6,
  relevantFiles: 6,
  surfaces: 5,
  modules: 5,
  contracts: 4,
  riskHotspots: 5,
  tests: 5,
  warnings: 6,
  notVerified: 8,
  changedContributors: 6,
};

export function buildDiscoveryContextSection(context?: DiscoveryReviewContext): string {
  if (!context) return '';
  const limits = { ...DEFAULT_LIMITS, ...context.limits };
  const lines: string[] = [
    '## Discovery Context',
    '',
    'Discovery Context is advisory falsification evidence, not review verdict authority.',
    'ReviewFindings, obligation binding, mandate digest, and attestation remain the review authority.',
    'If verification candidates exist, do not recommend only generic "run tests/build"; reference repo-native candidates or explicitly explain why not.',
    'If Discovery is unavailable, degraded, drifted, timed out, or not checked, mark Discovery-dependent claims NOT_VERIFIED.',
    '',
  ];

  appendHealth(lines, context.health);
  appendDrift(lines, context.drift, limits);
  appendDetectedStack(lines, context.detectedStack, limits);
  appendVerificationCandidates(lines, context.verificationCandidates ?? [], limits);
  appendImplementationGuidance(lines, context.implementationGuidance ?? null, limits);
  appendNotVerified(lines, 'Context NOT_VERIFIED', context.notVerified ?? [], limits.notVerified);

  return trimTrailingBlanks(lines).join('\n');
}

function appendHealth(lines: string[], health: DiscoveryHealthProjection | null | undefined): void {
  lines.push('### Health');
  if (!health) {
    lines.push('- status: unavailable', '- NOT_VERIFIED: Discovery health was not available.', '');
    return;
  }
  if (health.status === 'unavailable') {
    lines.push(
      '- status: unavailable',
      `- reason: ${health.reason}`,
      `- recovery: ${health.recovery}`,
      ...health.notVerified.map((item) => `- ${ensureNotVerified(item)}`),
      '',
    );
    return;
  }
  lines.push(
    '- status: available',
    `- healthy: ${String(health.healthy)}`,
    `- collectors: complete=${health.completeCollectors}, partial=${health.partialCollectors}, failed=${health.failedCollectors}`,
  );
  if (health.failedCollectorNames.length > 0) {
    lines.push(`- failedCollectors: ${health.failedCollectorNames.join(', ')}`);
  }
  if (health.hasBudgetExhaustion)
    lines.push('- warning: code-surface analysis exhausted its budget');
  if (health.readFailureCount > 0) lines.push(`- warning: readFailures=${health.readFailureCount}`);
  if (health.ageWarning) lines.push(`- warning: ${health.ageWarning}`);
  if (!health.healthy) {
    lines.push(
      '- NOT_VERIFIED: Discovery is degraded; stack, file, and verification guidance may be incomplete.',
    );
  }
  lines.push('');
}

function appendDrift(
  lines: string[],
  drift: DiscoveryDriftStatusProjection | null | undefined,
  limits: DiscoveryContextLimits,
): void {
  lines.push('### Drift');
  if (!drift) {
    lines.push('- status: not_checked', '- NOT_VERIFIED: Discovery drift was not checked.', '');
    return;
  }
  lines.push(`- status: ${drift.status}`, `- drifted: ${String(drift.drifted)}`);
  if (drift.changedContributorNames.length > 0) {
    lines.push(
      `- changedContributors: ${drift.changedContributorNames.slice(0, limits.changedContributors).join(', ')}`,
    );
  }
  appendWarnings(lines, drift.warnings, limits.warnings);
  appendNotVerified(lines, 'Drift NOT_VERIFIED', drift.notVerified, limits.notVerified);
  lines.push('');
}

function appendDetectedStack(
  lines: string[],
  stack: DetectedStack | null | undefined,
  limits: DiscoveryContextLimits,
): void {
  lines.push('### Detected Stack');
  if (!stack) {
    lines.push(
      '- none detected or unavailable',
      '- NOT_VERIFIED: Stack-specific claims require repository evidence.',
      '',
    );
    return;
  }
  lines.push(`- summary: ${stack.summary || 'none'}`);
  for (const item of stack.items.slice(0, limits.stackItems)) {
    const version = item.version ? `=${item.version}` : '';
    const evidence = item.evidence ? ` (evidence: ${item.evidence})` : '';
    lines.push(`- ${item.kind}: ${item.id}${version}${evidence}`);
  }
  lines.push('');
}

function appendVerificationCandidates(
  lines: string[],
  candidates: VerificationCandidates,
  limits: DiscoveryContextLimits,
): void {
  lines.push('### Verification Candidates');
  if (candidates.length === 0) {
    lines.push(
      '- none',
      '- NOT_VERIFIED: No repo-native verification candidates are available; do not invent them.',
      '',
    );
    return;
  }
  lines.push('- advisory only; these are not executed checks');
  for (const candidate of candidates.slice(0, limits.verificationCandidates)) {
    lines.push(
      `- ${candidate.kind}: ${candidate.command} (source: ${candidate.source}; confidence: ${candidate.confidence}; reason: ${candidate.reason})`,
    );
  }
  lines.push('');
}

function appendImplementationGuidance(
  lines: string[],
  guidance: DiscoveryReviewContext['implementationGuidance'],
  limits: DiscoveryContextLimits,
): void {
  lines.push('### Implementation Guidance');
  if (!guidance) {
    lines.push('- unavailable', '- NOT_VERIFIED: Implementation guidance was not available.', '');
    return;
  }
  lines.push(`- confidence: ${guidance.confidence}`);
  appendItems(lines, 'Relevant Files', guidance.relevantFiles, limits.relevantFiles);
  appendItems(lines, 'Surfaces', guidance.surfaces, limits.surfaces);
  appendItems(lines, 'Modules', guidance.modules, limits.modules);
  appendItems(lines, 'Contracts', guidance.contracts, limits.contracts);
  appendItems(lines, 'Risk Hotspots', guidance.riskHotspots, limits.riskHotspots);
  appendItems(lines, 'Tests', guidance.tests, limits.tests);
  appendWarnings(lines, guidance.warnings, limits.warnings);
  appendNotVerified(lines, 'Guidance NOT_VERIFIED', guidance.notVerified, limits.notVerified);
  lines.push('');
}

function appendItems(
  lines: string[],
  label: string,
  items: readonly ImplementationGuidanceItem[],
  limit: number,
): void {
  if (items.length === 0) return;
  lines.push(`- ${label}:`);
  for (const item of items.slice(0, limit)) {
    const path = item.path ? ` path=${item.path};` : '';
    const evidence = item.evidence.length > 0 ? ` evidence=${item.evidence.join(' | ')};` : '';
    lines.push(
      `  - ${item.label} (${path} confidence=${item.confidence}; source=${item.source};${evidence})`,
    );
  }
}

function appendWarnings(
  lines: string[],
  warnings: readonly { code: string; message: string }[],
  limit: number,
): void {
  if (warnings.length === 0) return;
  lines.push('- Warnings:');
  for (const warning of warnings.slice(0, limit)) {
    lines.push(`  - ${warning.code}: ${warning.message}`);
  }
}

function appendNotVerified(
  lines: string[],
  label: string,
  items: readonly string[],
  limit: number,
): void {
  if (items.length === 0) return;
  lines.push(`- ${label}:`);
  for (const item of items.slice(0, limit)) {
    lines.push(`  - ${ensureNotVerified(item)}`);
  }
}

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
    lines.push(
      `- ${candidate.kind}: ${candidate.command} (source: ${candidate.source}; confidence: ${candidate.confidence})`,
    );
  }
  lines.push('');
}

function trimTrailingBlanks(lines: string[]): string[] {
  const next = [...lines];
  while (next[next.length - 1] === '') next.pop();
  return next;
}

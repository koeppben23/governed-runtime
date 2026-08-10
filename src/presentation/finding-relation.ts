/**
 * @module presentation/finding-relation
 * @description Pure, display-only projection of already-validated finding relations.
 */

import type {
  FindingRelationPresentation,
  FindingRepositoryLocation,
  FindingSubject,
} from './model.js';

export function projectFindingRelation(relation: FindingRelationPresentation | undefined): {
  readonly subjects: readonly FindingSubject[];
  readonly evidence: readonly FindingRepositoryLocation[];
} {
  return {
    subjects: relation?.subjectAnchors ?? [],
    evidence: relation?.evidenceLocations ?? [],
  };
}

export function formatFindingLocation(location: FindingRepositoryLocation): string {
  const lines =
    location.line === undefined
      ? ''
      : `:${location.line}${location.endLine === undefined ? '' : `–${location.endLine}`}`;
  return `${location.revision.toUpperCase()} · ${location.path}${lines}`;
}

export function formatFindingSubject(subject: FindingSubject): string {
  if (subject.kind === 'repository_location') return formatFindingLocation(subject.location);
  const artifact = subject.artifactKind === 'plan' ? 'Plan' : 'ADR';
  return `${artifact} · ${subject.sectionPath.map((section) => section.headingText).join(' › ')}`;
}

export function formatFindingAffected(subjects: readonly FindingSubject[]): string {
  if (subjects.length === 0) return 'Affected: not cited';
  if (subjects.length === 1) return `Affected: ${formatFindingSubject(subjects[0]!)}`;
  return `Affected: ${subjects.length} reviewed locations`;
}

export function formatFindingEvidence(evidence: readonly FindingRepositoryLocation[]): string {
  return evidence.length === 0 ? 'Evidence: none cited' : `Evidence: ${evidence.length} cited`;
}

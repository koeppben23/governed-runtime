/**
 * @module presentation/finding-relation
 * @description Pure, display-only projection of already-validated finding relations.
 */

import type {
  FindingRelationPresentation,
  FindingRepositoryLocation,
  FindingSubject,
} from './model.js';

export function projectFindingRelation(relation: FindingRelationPresentation | undefined):
  | {
      readonly subjects: readonly FindingSubject[];
      readonly evidence: readonly FindingRepositoryLocation[];
    }
  | Record<never, never> {
  if (relation === undefined) return {};
  return {
    subjects: relation.subjectAnchors.map((subject) => {
      if (subject.kind === 'repository_location') {
        return {
          kind: 'repository_location' as const,
          location: projectLocation(subject.location),
        };
      }
      if (subject.kind === 'artifact_section') {
        return {
          kind: 'artifact_section' as const,
          artifactKind: subject.artifactKind,
          sectionPath: subject.sectionPath.map(({ headingText }) => ({ headingText })),
        };
      }
      if (subject.kind === 'implementation') {
        return {
          kind: 'implementation' as const,
          implementationDigest: subject.implementationDigest,
        };
      }
      return {
        kind: 'content' as const,
        subjectDigest: subject.subjectDigest,
        ...(subject.range === undefined ? {} : { range: subject.range }),
      };
    }),
    evidence: relation.evidenceLocations.map(projectLocation),
  };
}

function projectLocation(location: FindingRepositoryLocation): FindingRepositoryLocation {
  return {
    path: location.path,
    revision: location.revision,
    ...(location.line === undefined ? {} : { line: location.line }),
    ...(location.endLine === undefined ? {} : { endLine: location.endLine }),
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
  if (subject.kind === 'content') {
    const range = subject.range;
    const lines = range
      ? `:${range.startLine}${range.endLine === undefined ? '' : `-${range.endLine}`}`
      : '';
    return `Content ${subject.subjectDigest.slice(0, 12)}${lines}`;
  }
  if (subject.kind === 'implementation') {
    return `Implementation ${subject.implementationDigest.slice(0, 12)}`;
  }
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

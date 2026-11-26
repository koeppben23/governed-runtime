/**
 * @module integration/review/finding-relation-grammar
 * @description Deterministic, machine-consistent FindingRelation grammar for
 * reviewer prompts. Rendered from reviewer-contract.ts, whose enum values and
 * kind lists are derived from the canonical Zod schemas at import time, so the
 * grammar and the binding gate can never disagree. Every reviewer transport
 * MUST receive this grammar so no path can guess the schema that the other path
 * enforces.
 */
import { SEVERITY_VALUES, CATEGORY_VALUES, REVISION_VALUES } from '../context/reviewer-contract.js';
import type { AdmittedSubjectAnchorKind } from '../../../state/evidence-review-subject.js';

/**
 * Shape examples per admissible subject-anchor kind. Only the kind admitted by
 * the current review scope is rendered, so a reviewer is never shown an anchor
 * the binding gate would reject as out of scope.
 */
function anchorShapeBlocks(
  revisions: string,
): Readonly<Record<AdmittedSubjectAnchorKind, readonly string[]>> {
  return {
    repository_location: [
      'repository_location (for file-level targets):',
      '{',
      '  "kind": "repository_location",',
      '  "location": {',
      '    "path": "<string>",',
      `    "revision": ${revisions},`,
      '    "line": <integer optional>,',
      '    "endLine": <integer optional>',
      '  }',
      '}',
    ],
    artifact_section: [
      'artifact_section (for plan/ADR section targets):',
      '{',
      '  "kind": "artifact_section",',
      '  "artifactKind": "plan" | "adr",',
      '  "artifactDigest": "<string>",',
      '  "sectionPath": [{"headingDepth": <int 1-6>, "siblingIndex": <int >=1>, "headingText": "<string>"}]',
      '}',
    ],
    content: [
      'content (for external content targets):',
      '{',
      '  "kind": "content",',
      '  "subjectDigest": "<string>",',
      '  "range": { "startLine": <int >=1>, "endLine": <int >=1 optional> }',
      '}',
    ],
    implementation: [
      'implementation (for implementation review subjects — subject identity ONLY,',
      'never repository evidence: no path, line, revision, or diffDigest):',
      '{',
      '  "kind": "implementation",',
      '  "implementationDigest": "<string>"',
      '}',
    ],
  };
}

/**
 * Revision rules derived from the revisions this review actually offers (the
 * same `resolveObservationRevisions` projection that the observation contract
 * and `flowguard_observe_repository` use). Without offered revisions the
 * schema vocabulary is shown, but no revision is observable.
 */
function renderRevisionRules(offered: readonly string[]): string[] {
  if (offered.length === 0) {
    return [
      'This review offers no repository revision: it carries no frozen repository',
      'observation authority, so no repository location can become evidence.',
    ];
  }
  const list = offered.map((r) => `"${r}"`).join(' | ');
  return [
    offered.length === 1
      ? `Only ${list} is valid for this review.`
      : `Only ${list} are valid for this review.`,
  ];
}

export function renderFindingRelationGrammar(
  offeredRevisions: readonly ('base' | 'head')[],
  admittedAnchorKind?: AdmittedSubjectAnchorKind | null,
): string {
  const severities = SEVERITY_VALUES.map((s) => `"${s}"`).join(' | ');
  const categories = CATEGORY_VALUES.map((c) => `"${c}"`).join(' | ');
  const offered = REVISION_VALUES.filter((r) => offeredRevisions.includes(r));
  const revisions = (offered.length > 0 ? offered : REVISION_VALUES)
    .map((r) => `"${r}"`)
    .join(' | ');
  const blocks = anchorShapeBlocks(revisions);
  // undefined keeps the full vocabulary (callers without obligation scope);
  // null states explicitly that no anchor kind is admissible.
  const admittedKinds: readonly AdmittedSubjectAnchorKind[] =
    admittedAnchorKind === undefined
      ? (Object.keys(blocks) as AdmittedSubjectAnchorKind[])
      : admittedAnchorKind === null
        ? []
        : [admittedAnchorKind];
  const anchorSection =
    admittedKinds.length === 0
      ? ['### subjectAnchors', '', 'No subject anchor is admissible for the current review scope.']
      : [
          '### subjectAnchors',
          '',
          `Subject anchors identify what is being criticized. Use ${
            admittedKinds.length === 1
              ? `"${admittedKinds[0]}"`
              : `ONE of: ${admittedKinds.map((k) => `"${k}"`).join(', ')}`
          }`,
          '',
          ...admittedKinds.flatMap((kind, index) =>
            index === 0 ? [...blocks[kind]] : ['', ...blocks[kind]],
          ),
        ];

  return [
    '## Finding Output Contract',
    '',
    'Every material finding MUST include a structured relation:',
    '',
    '{',
    `  "severity": ${severities},`,
    `  "category": ${categories},`,
    '  "message": "<specific defect description>",',
    '  "relation": {',
    '    "subjectAnchors": [ ... ],   // min 1, identifies what is criticized',
    '    "evidenceLocations": [ ... ]  // required, may be empty; repository evidence',
    '  }',
    '}',
    '',
    ...anchorSection,
    '',
    '### evidenceLocations (required, may be empty)',
    '',
    'Array of repository location entries, each with:',
    '{',
    '  "path": "<string>",',
    `  "revision": ${revisions},`,
    '  "line": <integer optional>,',
    '  "endLine": <integer optional>',
    '}',
    '',
    'evidenceLocations is REQUIRED on every relation but MAY be empty (use [] for no',
    'evidence). Omitting the key is a schema violation.',
    'evidenceLocations MAY reference repository locations within the frozen repository',
    'authority available to this review. A cited location does not itself establish',
    'observation: a location is admissible only when its frozen bytes were obtained',
    'through flowguard_observe_repository during this review attempt.',
    '',
    '### Revision Rules',
    '',
    'revision is a frozen alias, never a SHA.',
    ...renderRevisionRules(offered),
  ].join('\n');
}

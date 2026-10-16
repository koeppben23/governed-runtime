/**
 * @module integration/review/finding-relation-grammar
 * @description Deterministic, machine-consistent FindingRelation grammar for
 * reviewer prompts. Rendered from reviewer-contract.ts, whose enum values and
 * kind lists are derived from the canonical Zod schemas at import time, so the
 * grammar and the binding gate can never disagree. Every reviewer transport
 * MUST receive this grammar so no path can guess the schema that the other path
 * enforces.
 */
import {
  SEVERITY_VALUES,
  CATEGORY_VALUES,
  REVISION_VALUES,
  ANCHOR_KINDS,
} from '../context/reviewer-contract.js';

/** Subject anchor shapes that never carry a repository revision. */
const NON_REPOSITORY_ANCHOR_SHAPES: readonly string[] = [
  'artifact_section (for plan/ADR section targets):',
  '{',
  '  "kind": "artifact_section",',
  '  "artifactKind": "plan" | "adr",',
  '  "artifactDigest": "<string>",',
  '  "sectionPath": [{"headingDepth": <int 1-6>, "siblingIndex": <int >=1>, "headingText": "<string>"}]',
  '}',
  '',
  'content (for external content targets):',
  '{',
  '  "kind": "content",',
  '  "subjectDigest": "<string>",',
  '  "range": { "startLine": <int >=1>, "endLine": <int >=1 optional> }',
  '}',
  '',
  'implementation (for implementation review subjects — subject identity ONLY,',
  'never repository evidence: no path, line, revision, or diffDigest):',
  '{',
  '  "kind": "implementation",',
  '  "implementationDigest": "<string>"',
  '}',
];

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
): string {
  const severities = SEVERITY_VALUES.map((s) => `"${s}"`).join(' | ');
  const categories = CATEGORY_VALUES.map((c) => `"${c}"`).join(' | ');
  const offered = REVISION_VALUES.filter((r) => offeredRevisions.includes(r));
  const revisions = (offered.length > 0 ? offered : REVISION_VALUES)
    .map((r) => `"${r}"`)
    .join(' | ');

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
    '    "evidenceLocations": [ ... ]  // optional, repository evidence',
    '  }',
    '}',
    '',
    '### subjectAnchors',
    '',
    `Subject anchors identify what is being criticized. Use ONE of: ${ANCHOR_KINDS.map((k) => `"${k}"`).join(', ')}`,
    '',
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
    '',
    ...NON_REPOSITORY_ANCHOR_SHAPES,

    '',
    '### evidenceLocations (optional)',
    '',
    'Array of repository location entries, each with:',
    '{',
    '  "path": "<string>",',
    `  "revision": ${revisions},`,
    '  "line": <integer optional>,',
    '  "endLine": <integer optional>',
    '}',
    '',
    'evidenceLocations MAY be empty (use [] for no evidence).',
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

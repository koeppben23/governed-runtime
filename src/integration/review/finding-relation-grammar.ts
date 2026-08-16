/**
 * @module integration/review/finding-relation-grammar
 * @description Deterministic, machine-consistent FindingRelation grammar for
 * reviewer prompts. Rendered from reviewer-contract.ts (the canonical SSOT),
 * which is verified against the Zod schemas by reviewer-contract.test.ts.
 * Every reviewer transport MUST receive this grammar so no path can guess the
 * schema that the other path enforces.
 */
import {
  SEVERITY_VALUES,
  CATEGORY_VALUES,
  REVISION_VALUES,
  ANCHOR_KINDS,
} from './reviewer-contract.js';

export function renderFindingRelationGrammar(): string {
  const severities = SEVERITY_VALUES.map((s) => `"${s}"`).join(' | ');
  const categories = CATEGORY_VALUES.map((c) => `"${c}"`).join(' | ');
  const revisions = REVISION_VALUES.map((r) => `"${r}"`).join(' | ');

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
    `Only ${revisions} are valid.`,
  ].join('\n');
}

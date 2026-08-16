/**
 * @module integration/review/observation-contract-prompt
 * @description Canonical Repository Observation Contract rendered into every
 *              reviewer prompt.
 *
 * Investigation (read/glob/grep) is never repository evidence authority. Only
 * the sanctioned observation tool, invoked with the attempt's opaque
 * observation capability, produces bytes that may be cited as an
 * evidenceLocation.
 *
 * @version v1
 */

export function renderRepositoryObservationContract(
  capability: string | undefined,
  revisions: readonly ('base' | 'head')[],
): string[] {
  if (!capability || revisions.length === 0) {
    return [
      '## Repository Observation',
      '',
      'This review attempt has NO frozen repository observation authority.',
      'Repository evidenceLocations are unavailable: do not cite repository',
      'locations as evidence for this review.',
      '',
    ];
  }
  const revisionExpression = revisions.length === 1 ? `"${revisions[0]}"` : '<base|head>';
  return [
    '## Repository Observation Contract',
    '',
    'Read/Glob/Grep investigation output is NEVER repository evidence authority.',
    'To make a repository evidenceLocation admissible, you MUST obtain the exact',
    'frozen material through the sanctioned observation tool during THIS review',
    'attempt:',
    '',
    `  flowguard_observe_repository({ capability: "${capability}", revision: ${revisionExpression}, path: "<repository-relative path>" })`,
    '',
    'The returned observation is the ONLY admissible basis for citing that',
    'location. Cite { path, revision } exactly as observed. Worktree reads,',
    'recalled content, or citations without a matching observation cannot bind.',
    '',
  ];
}

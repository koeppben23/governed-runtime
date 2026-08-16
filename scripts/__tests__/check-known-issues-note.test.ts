import { describe, it, expect } from 'vitest';
import { WATCHED_PREFIXES, knownIssuesNoteForChangedFiles } from '../check-known-issues-note.mjs';

describe('knownIssuesNoteForChangedFiles', () => {
  it('warns when trust-boundary paths change without KNOWN_ISSUES.md', () => {
    const result = knownIssuesNoteForChangedFiles([
      'src/rails/review-decision.ts',
      'src/audit/proofgraph/gate.ts',
    ]);
    expect(result.kind).toBe('warning');
    expect(result.message).toContain('KNOWN_ISSUES.md');
    expect(result.message).toContain('src/rails/');
  });

  it('stays silent when trust-boundary paths change together with KNOWN_ISSUES.md', () => {
    const result = knownIssuesNoteForChangedFiles([
      'KNOWN_ISSUES.md',
      'src/integration/review/orchestrator.ts',
      'src/adapters/persistence.ts',
    ]);
    expect(result.kind).toBe('ok');
  });

  it('skips when no watched path changed (docs-only PR)', () => {
    const result = knownIssuesNoteForChangedFiles(['docs/troubleshooting.md', 'package.json']);
    expect(result.kind).toBe('skip');
  });

  it('skips when only KNOWN_ISSUES.md itself changes', () => {
    const result = knownIssuesNoteForChangedFiles(['KNOWN_ISSUES.md']);
    expect(result.kind).toBe('skip');
  });

  it('does not match look-alike prefixes without the directory separator', () => {
    const result = knownIssuesNoteForChangedFiles(['src/railsmith/plan.ts']);
    expect(result.kind).toBe('skip');
  });

  it('normalizes rename entries (old => new) to the new path', () => {
    const renamed = knownIssuesNoteForChangedFiles(['docs/old.md => src/rails/review.ts']);
    expect(renamed.kind).toBe('warning');

    const renamedOut = knownIssuesNoteForChangedFiles(['src/rails/review.ts => docs/new.md']);
    expect(renamedOut.kind).toBe('skip');
  });

  it('pins the watched prefix list', () => {
    expect(WATCHED_PREFIXES).toEqual([
      'src/rails/',
      'src/integration/review/',
      'src/adapters/',
      'src/audit/proofgraph/',
    ]);
  });
});

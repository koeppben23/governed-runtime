/**
 * @module architecture/reviewer-contract-ssot
 * @description Canonical authorities guard for the reviewer-facing contract.
 * Prevents duplicate registries, invalid revision aliases, and semantic repair
 * from creeping into reviewer contracts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(process.cwd(), 'src');

/** Files that participate in the reviewer contract — they must use canonical types. */
const REVIEWER_CONTRACT_FILES = [
  'integration/review/findings-schema.ts',
  'integration/review/finding-relation-grammar.ts',
  'integration/review/prompt-builders.ts',
  'templates/mandates-reviewer-criteria.ts',
] as const;

/** Canonical severity values from Finding.severity */
const CANONICAL_SEVERITIES = ['critical', 'major', 'minor'];

/** Canonical revision aliases from RepositoryLocation.revision */
const CANONICAL_REVISIONS = ['base', 'head'];

/** Canonical subject anchor kinds from ReviewSubjectAnchor */
const CANONICAL_ANCHOR_KINDS = ['repository_location', 'artifact_section', 'content'];

describe('reviewer contract SSOT guard', () => {
  it('no file declares "current" or "modified" as revision values', () => {
    const violations: string[] = [];
    for (const filePath of REVIEWER_CONTRACT_FILES) {
      const content = readFileSync(join(SRC_ROOT, filePath), 'utf8');
      const lines = content.split('\n');
      for (const [i, line] of lines.entries()) {
        if (line.includes('"current"') && line.includes('revision')) {
          violations.push(`${filePath}:${i + 1}: contains "current" near revision context`);
        }
        if (line.includes('"modified"') && line.includes('revision')) {
          violations.push(`${filePath}:${i + 1}: contains "modified" near revision context`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('no reviewer contract file duplicates severity enum from canonical source', () => {
    for (const filePath of REVIEWER_CONTRACT_FILES) {
      const content = readFileSync(join(SRC_ROOT, filePath), 'utf8');
      // Find arrays that look like severity enums
      const enumPattern = /\bseverity\b[^}]*enum:\s*\[([^\]]+)\]/gs;
      let match: RegExpExecArray | null;
      while ((match = enumPattern.exec(content)) !== null) {
        const raw = match[1] ?? '';
        // Skip spread imports like [...CANONICAL_SEVERITIES] — these are valid
        // references to canonical types, not hardcoded enum arrays.
        if (raw.trim().startsWith('...')) continue;
        const values = raw.split(',').map((s) => s.trim().replace(/['"]/g, ''));
        const missing = CANONICAL_SEVERITIES.filter((s) => !values.includes(s));
        const extra = values.filter((s) => s.length > 0 && !CANONICAL_SEVERITIES.includes(s));
        if (missing.length > 0 || extra.length > 0) {
          const line = content.slice(0, match.index).split('\n').length;
          expect(`${filePath}:${line}: severity enum drift`).toBe('none');
        }
      }
    }
  });

  it('all reviewer contract files reference only canonical anchor kind values', () => {
    const invalidKinds = ['file_path', 'source_file', 'commit_range', 'branch_ref'];
    const violations: string[] = [];
    for (const filePath of REVIEWER_CONTRACT_FILES) {
      const content = readFileSync(join(SRC_ROOT, filePath), 'utf8');
      for (const kind of invalidKinds) {
        if (content.includes(`"${kind}"`) || content.includes(`'${kind}'`)) {
          const line = content.split(`"${kind}"`)[0]!.split('\n').length;
          violations.push(`${filePath}:${line}: invalid anchor kind "${kind}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('mandates-reviewer-criteria.ts does not reference non-canonical type names', () => {
    // ArtifactAnchor was the old incorrect name; correct is ArtifactSectionAnchor.
    const invalidTypeNames = ['ArtifactAnchor'];
    const content = readFileSync(join(SRC_ROOT, 'templates/mandates-reviewer-criteria.ts'), 'utf8');
    const violations: string[] = [];
    for (const name of invalidTypeNames) {
      if (content.includes(`<${name}>`) || content.includes(`<${name} |`)) {
        const line = content.split(`<${name}`)[0]!.split('\n').length;
        violations.push(`line ${line}: references deprecated type "${name}"`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('finding-relation-grammar.ts documents all three canonical anchor kinds', () => {
    const content = readFileSync(
      join(SRC_ROOT, 'integration/review/finding-relation-grammar.ts'),
      'utf8',
    );
    for (const kind of CANONICAL_ANCHOR_KINDS) {
      expect(content).toContain(kind);
    }
  });

  it('finding-relation-grammar.ts documents both canonical revision aliases', () => {
    const content = readFileSync(
      join(SRC_ROOT, 'integration/review/finding-relation-grammar.ts'),
      'utf8',
    );
    expect(content).toContain('"base" | "head"');
    expect(content).toContain('revision is a frozen alias');
    expect(content).toContain('never a SHA');
  });

  it('finding-relation-grammar.ts documents evidenceLocations as optional', () => {
    const content = readFileSync(
      join(SRC_ROOT, 'integration/review/finding-relation-grammar.ts'),
      'utf8',
    );
    expect(content).toContain('evidenceLocations MAY be empty');
    expect(content).toContain('do not replace');
  });

  it('prompt-builders.ts imports grammar from finding-relation-grammar.ts', () => {
    const content = readFileSync(join(SRC_ROOT, 'integration/review/prompt-builders.ts'), 'utf8');
    expect(content).toContain("from './finding-relation-grammar.js'");
  });

  it('findings-schema.ts imports severity and category enums from schema-introspect', () => {
    const content = readFileSync(join(SRC_ROOT, 'integration/review/findings-schema.ts'), 'utf8');
    expect(content).toContain("from './schema-introspect.js'");
    expect(content).toContain('CANONICAL_SEVERITIES');
    expect(content).toContain('CANONICAL_CATEGORIES');
  });
});

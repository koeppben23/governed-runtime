import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * @module architecture/human-projection-ssot.test
 * @description Anti-drift guard for the Human Projection layer
 * (`src/presentation/human-projection.ts`, `src/presentation/reason-projection.ts`).
 *
 * The Human Projection is the READ-ONLY presentation-owned layer that explains
 * governance outcomes to a human without becoming a second authority. These
 * two modules own the only two non-trivial derivations in that layer:
 *
 *   A. Reason-code recovery guidance MUST be derived by
 *      `projectReasonFromRegistry` (`presentation/reason-projection.ts`) — the
 *      single consumer of the canonical reason registry in the presentation
 *      layer. Any other presentation module that reads
 *      `defaultReasonRegistry` (or imports `config/reasons.js`) to format
 *      recovery steps is a duplicate-authority drift hazard: summaries and
 *      steps must come from the projection, never hand-formatted.
 *
 *   B. Command → action-intent mapping MUST be defined only in
 *      `presentation/human-projection.ts` (`INTENT_COMMANDS` /
 *      `projectActionIntent`). Any other presentation module that builds its
 *      own command-to-intent table derives projected actions from scratch.
 *
 * Mechanism mirrors `mode-validation-ssot.test.ts`: a pure detector over
 * production source, plus inline negative fixtures proving the detector fires.
 * `*.test.ts` and `__tests__/` are excluded so the guard never flags itself.
 */

const SRC_ROOT = join(process.cwd(), 'src');
const PRESENTATION_DIR = 'presentation';

const RECOVERY_AUTHORITY = 'presentation/reason-projection.ts';
const INTENT_AUTHORITY = 'presentation/human-projection.ts';

const REGISTRY_IDIOM = /defaultReasonRegistry/;
const REGISTRY_IMPORT_IDIOM = /from\s+['"][^'"]*config\/reasons\.js['"]/;
const INTENT_TABLE_IDIOM = /Record<ActionIntent\s*,/;

interface SourceFile {
  readonly rel: string;
  readonly content: string;
}

interface Violation {
  readonly rel: string;
  readonly line: number;
  readonly snippet: string;
  readonly rule: string;
}

function collectPresentationFiles(dir: string, acc: SourceFile[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      collectPresentationFiles(full, acc);
      continue;
    }
    if (!entry.isFile() || !full.endsWith('.ts') || full.endsWith('.test.ts')) continue;
    const rel = relative(SRC_ROOT, full).split(sep).join('/');
    if (!rel.startsWith(PRESENTATION_DIR)) continue;
    acc.push({ rel, content: readFileSync(full, 'utf8') });
  }
}

function findRegistryViolations(files: readonly SourceFile[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.rel === RECOVERY_AUTHORITY) continue;
    f.content.split('\n').forEach((text, i) => {
      if (REGISTRY_IDIOM.test(text) || REGISTRY_IMPORT_IDIOM.test(text)) {
        out.push({
          rel: f.rel,
          line: i + 1,
          snippet: text.trim(),
          rule: 'duplicate-recovery-authority',
        });
      }
    });
  }
  return out;
}

function findIntentTableViolations(files: readonly SourceFile[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.rel === INTENT_AUTHORITY) continue;
    f.content.split('\n').forEach((text, i) => {
      if (INTENT_TABLE_IDIOM.test(text)) {
        out.push({
          rel: f.rel,
          line: i + 1,
          snippet: text.trim(),
          rule: 'duplicate-intent-table',
        });
      }
    });
  }
  return out;
}

describe('human-projection SSOT (anti-drift)', () => {
  const files: SourceFile[] = [];
  collectPresentationFiles(SRC_ROOT, files);

  it('only reason-projection.ts consumes the canonical reason registry in presentation', () => {
    const violations = findRegistryViolations(files);
    if (violations.length > 0) {
      console.error('Reason-registry SSOT violations:', violations);
    }
    expect(violations).toEqual([]);
  });

  it('only human-projection.ts defines the command-to-intent table', () => {
    const violations = findIntentTableViolations(files);
    if (violations.length > 0) {
      console.error('Action-intent SSOT violations:', violations);
    }
    expect(violations).toEqual([]);
  });

  describe('negative fixtures — prove the detectors fire', () => {
    it('detects a duplicate registry consumer outside the authority', () => {
      const fixture: SourceFile[] = [
        {
          rel: 'presentation/rogue-summary.ts',
          content:
            "import { defaultReasonRegistry } from '../config/reasons.js';\n" +
            'const recovery = defaultReasonRegistry.get("PLAN_REQUIRED")?.recoverySteps;',
        },
      ];
      const violations = findRegistryViolations(fixture);
      expect(violations).toHaveLength(2);
      expect(violations.every((v) => v.rule === 'duplicate-recovery-authority')).toBe(true);
    });

    it('detects an import-only duplicate registry consumer', () => {
      const fixture: SourceFile[] = [
        {
          rel: 'presentation/rogue-import.ts',
          content: "import { formatReason } from '../config/reasons.js';",
        },
      ];
      const violations = findRegistryViolations(fixture);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.rule).toBe('duplicate-recovery-authority');
    });

    it('detects a duplicate intent table outside the authority', () => {
      const fixture: SourceFile[] = [
        {
          rel: 'presentation/rogue-intents.ts',
          content:
            'const LOCAL_INTENTS: Record<ActionIntent, string> = { refresh_repository: "/start" };',
        },
      ];
      const violations = findIntentTableViolations(fixture);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.rule).toBe('duplicate-intent-table');
    });

    it('does NOT flag the canonical authorities', () => {
      const fixture: SourceFile[] = [
        {
          rel: RECOVERY_AUTHORITY,
          content:
            "import { defaultReasonRegistry } from '../config/reasons.js';\n" +
            'const reason = defaultReasonRegistry.get("PLAN_REQUIRED");',
        },
        {
          rel: INTENT_AUTHORITY,
          content: 'const INTENT_COMMANDS: Record<ActionIntent, readonly string[]> = {};',
        },
      ];
      expect(findRegistryViolations(fixture)).toEqual([]);
      expect(findIntentTableViolations(fixture)).toEqual([]);
    });
  });
});

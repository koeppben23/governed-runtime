import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * @module architecture/human-projection-ssot.test
 * @description Anti-drift guard for the Human Projection layer
 * (`src/presentation/human-projection.ts`, `src/presentation/reason-projection.ts`).
 *
 * The Human Projection is the READ-ONLY presentation-owned layer that explains
 * governance outcomes to a human without becoming a second authority. This
 * guard enforces two invariants across the modules that render the Human
 * Projection:
 *
 *   A. Reason-code recovery guidance MUST be derived by
 *      `projectReasonFromRegistry` (`presentation/reason-projection.ts`). The
 *      guard scans BOTH the presentation layer AND the real presentation
 *      renderers in `src/integration/` (`status-presentation.ts`,
 *      `why-presentation.ts`, `finish-presentation.ts`) for direct
 *      consumption of the canonical reason registry (`defaultReasonRegistry`
 *      / `config/reasons.js`). Only `reason-projection.ts` may consume it
 *      there — a renderer that imports the registry to format recovery steps
 *      directly is a duplicate-authority drift hazard.
 *
 *   B. The Human Projection modules MUST NOT define an independent
 *      slash-command catalogue. Command/invocation metadata is canonical in
 *      the command layer (`integration/installed-commands.ts`); the
 *      projection may later reference canonical command identity, but must
 *      not duplicate invocation metadata. This guard therefore rejects any
 *      slash-command string literal inside the Human Projection modules
 *      (`human-projection.ts`, `reason-projection.ts`).
 *
 * Mechanism mirrors `mode-validation-ssot.test.ts`: a pure detector over
 * production source, plus inline negative fixtures proving the detector fires.
 * `*.test.ts` and `__tests__/` are excluded so the guard never flags itself.
 */

const SRC_ROOT = join(process.cwd(), 'src');

/** The sole module permitted to consume the reason registry in the scanned scope. */
const RECOVERY_AUTHORITY = 'presentation/reason-projection.ts';

/** Scanned scope: presentation layer plus the integration presentation renderers. */
const PRESENTATION_RENDERER = 'integration/status-presentation.ts';
const PRESENTATION_RENDERER_WHY = 'integration/why-presentation.ts';
const PRESENTATION_RENDERER_FINISH = 'integration/finish-presentation.ts';

/** Human Projection modules that must not carry slash-command invocation metadata. */
const HUMAN_PROJECTION_MODULES = [
  'presentation/human-projection.ts',
  'presentation/reason-projection.ts',
] as const;

const PRESENTATION_DIR = 'presentation';

const REGISTRY_IDIOM = /defaultReasonRegistry/;
const REGISTRY_IMPORT_IDIOM = /from\s+['"][^'"]*config\/reasons\.js['"]/;
const SLASH_COMMAND_IDIOM = /'\/[a-z][a-z0-9-]*'/;

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

function collectFiles(dir: string, acc: SourceFile[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      collectFiles(full, acc);
      continue;
    }
    if (!entry.isFile() || !full.endsWith('.ts') || full.endsWith('.test.ts')) continue;
    const rel = relative(SRC_ROOT, full).split(sep).join('/');
    acc.push({ rel, content: readFileSync(full, 'utf8') });
  }
}

function isInScope(rel: string): boolean {
  if (rel.startsWith(PRESENTATION_DIR)) return true;
  return (
    rel === PRESENTATION_RENDERER ||
    rel === PRESENTATION_RENDERER_WHY ||
    rel === PRESENTATION_RENDERER_FINISH
  );
}

function findRegistryViolations(files: readonly SourceFile[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.rel === RECOVERY_AUTHORITY) continue;
    if (!isInScope(f.rel)) continue;
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

function findSlashCommandViolations(files: readonly SourceFile[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (!(HUMAN_PROJECTION_MODULES as readonly string[]).includes(f.rel)) continue;
    f.content.split('\n').forEach((text, i) => {
      if (SLASH_COMMAND_IDIOM.test(text)) {
        out.push({
          rel: f.rel,
          line: i + 1,
          snippet: text.trim(),
          rule: 'duplicate-command-catalogue',
        });
      }
    });
  }
  return out;
}

describe('human-projection SSOT (anti-drift)', () => {
  const files: SourceFile[] = [];
  collectFiles(SRC_ROOT, files);

  it('only reason-projection.ts consumes the reason registry in presentation + integration renderers', () => {
    const violations = findRegistryViolations(files);
    if (violations.length > 0) {
      console.error('Reason-registry SSOT violations:', violations);
    }
    expect(violations).toEqual([]);
  });

  it('human-projection modules do not define a slash-command catalogue', () => {
    const violations = findSlashCommandViolations(files);
    if (violations.length > 0) {
      console.error('Slash-command catalogue violations:', violations);
    }
    expect(violations).toEqual([]);
  });

  describe('negative fixtures — prove the detectors fire', () => {
    it('detects a registry consumer inside an integration renderer', () => {
      const fixture: SourceFile[] = [
        {
          rel: PRESENTATION_RENDERER,
          content:
            "import { defaultReasonRegistry } from '../config/reasons.js';\n" +
            'const recovery = defaultReasonRegistry.get("PLAN_REQUIRED")?.recoverySteps;',
        },
      ];
      const violations = findRegistryViolations(fixture);
      expect(violations).toHaveLength(2);
      expect(violations.every((v) => v.rule === 'duplicate-recovery-authority')).toBe(true);
    });

    it('detects a registry consumer inside the presentation layer', () => {
      const fixture: SourceFile[] = [
        {
          rel: 'presentation/rogue-summary.ts',
          content:
            "import { formatReason } from '../config/reasons.js';\n" +
            'const steps = formatReason("PLAN_REQUIRED").recovery;',
        },
      ];
      const violations = findRegistryViolations(fixture);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.rule).toBe('duplicate-recovery-authority');
    });

    it('detects a slash-command catalogue inside a human-projection module', () => {
      const fixture: SourceFile[] = [
        {
          rel: 'presentation/human-projection.ts',
          content: "const INTENT_COMMANDS = { refresh_repository: ['/hydrate', '/start'] };",
        },
      ];
      const violations = findSlashCommandViolations(fixture);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.rule).toBe('duplicate-command-catalogue');
    });

    it('does NOT flag the canonical authority or renderers with no registry access', () => {
      const fixture: SourceFile[] = [
        {
          rel: RECOVERY_AUTHORITY,
          content:
            "import { defaultReasonRegistry } from '../config/reasons.js';\n" +
            'const reason = defaultReasonRegistry.get("PLAN_REQUIRED");',
        },
        {
          rel: PRESENTATION_RENDERER_WHY,
          content: "import { projectReasonFromRegistry } from '../presentation/index.js';",
        },
        {
          rel: 'presentation/phase-labels.ts',
          content: 'export const PHASE_LABELS = { READY: "Ready" };',
        },
      ];
      expect(findRegistryViolations(fixture)).toEqual([]);
      expect(findSlashCommandViolations(fixture)).toEqual([]);
    });
  });
});

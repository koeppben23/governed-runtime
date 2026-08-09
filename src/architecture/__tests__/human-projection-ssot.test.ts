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
 *      renderers under `src/integration/` (any module matching
 *      `integration/*-presentation.ts` — today `status-presentation.ts`,
 *      `why-presentation.ts`, `finish-presentation.ts`) for direct
 *      consumption of the canonical reason registry (`defaultReasonRegistry`
 *      / `config/reasons.js`). Only `reason-projection.ts` may consume it
 *      there — a renderer that imports the registry to format recovery steps
 *      directly is a duplicate-authority drift hazard.
 *
 *      The renderer scope is pattern-based (`integration/*-presentation.ts`)
 *      rather than a hardcoded file list so that future presentation builders
 *      are covered without editing this guard.
 *
 *   B. The Human Projection modules MUST NOT define an independent
 *      slash-command catalogue. Command/invocation metadata is canonical in
 *      the command layer (`integration/installed-commands.ts`); the
 *      projection may later reference canonical command identity, but must
 *      not duplicate invocation metadata. This guard therefore rejects any
 *      slash-command string literal inside the Human Projection modules
 *      (`human-projection.ts`, `reason-projection.ts`, `reason-copy.ts`).
 *
 *   C. Migrated reason-code copy (`headline`/`explanation`) and `impact`
 *      classification have a single authority: `presentation/reason-copy.ts`
 *      (the {@link REASON_COPY} table). `reason-projection.ts` MUST derive
 *      them through `lookupReasonCopy`; no other presentation module or
 *      integration renderer may define a parallel per-code impact map.
 *
 * Mechanism mirrors `mode-validation-ssot.test.ts`: a pure detector over
 * production source, plus inline negative fixtures proving the detector fires.
 * `*.test.ts` and `__tests__/` are excluded so the guard never flags itself.
 */

const SRC_ROOT = join(process.cwd(), 'src');

/** The sole module permitted to consume the reason registry in the scanned scope. */
const RECOVERY_AUTHORITY = 'presentation/reason-projection.ts';

/** The single authority for migrated reason-code copy and impact. */
const COPY_AUTHORITY = 'presentation/reason-copy.ts';

/** Presentation renderers under `src/integration/` share the same invariant. */
const INTEGRATION_DIR = 'integration/';

/** Human Projection modules that must not carry slash-command invocation metadata. */
const HUMAN_PROJECTION_MODULES = [
  'presentation/human-projection.ts',
  'presentation/reason-projection.ts',
  'presentation/reason-copy.ts',
] as const;

const PRESENTATION_DIR = 'presentation';

const REGISTRY_IDIOM = /defaultReasonRegistry/;
const REGISTRY_IMPORT_IDIOM = /from\s+['"][^'"]*config\/reasons\.js['"]/;
const SLASH_COMMAND_IDIOM = /'\/[a-z][a-z0-9-]*'/;
/** Literal per-code impact assignments — only the copy authority may hold them. */
const IMPACT_MAP_IDIOM = /impact:\s*['"]/;

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

function isIntegrationPresentationRenderer(rel: string): boolean {
  return rel.startsWith(INTEGRATION_DIR) && rel.endsWith('-presentation.ts');
}

function isInScope(rel: string): boolean {
  if (rel.startsWith(PRESENTATION_DIR)) return true;
  return isIntegrationPresentationRenderer(rel);
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

function findImpactMapViolations(files: readonly SourceFile[]): Violation[] {
  const out: Violation[] = [];
  // human-projection.ts is the impact copy authority; reason-copy.ts is the
  // migrated-reason-code impact authority.
  const IMPACT_AUTHORITIES = new Set([COPY_AUTHORITY, 'presentation/human-projection.ts']);
  for (const f of files) {
    if (IMPACT_AUTHORITIES.has(f.rel)) continue;
    if (!isInScope(f.rel)) continue;
    f.content.split('\n').forEach((text, i) => {
      if (IMPACT_MAP_IDIOM.test(text)) {
        out.push({
          rel: f.rel,
          line: i + 1,
          snippet: text.trim(),
          rule: 'parallel-impact-map',
        });
      }
      // Detect switch-on-UserImpact returning prose strings (parallel impact copy).
      // Must check for return of a STRING literal, not an object (conclusion dispatch
      // also uses 'case \'decision_required\'' but returns objects).
      if (
        /case\s+['"]workflow_blocked['"]\s*:.*return\s+['"]/.test(text) ||
        /case\s+['"]verification_incomplete['"]\s*:.*return\s+['"]/.test(text) ||
        /case\s+['"]review_required['"]\s*:.*return\s+['"]/.test(text) ||
        /case\s+['"]decision_required['"]\s*:.*return\s+['"]/.test(text) ||
        /case\s+['"]degraded_only['"]\s*:.*return\s+['"]/.test(text)
      ) {
        out.push({
          rel: f.rel,
          line: i + 1,
          snippet: text.trim(),
          rule: 'parallel-impact-switch',
        });
      }
    });
  }
  return out;
}

function findCopyDerivationViolations(files: readonly SourceFile[]): Violation[] {
  const out: Violation[] = [];
  const projection = files.find((f) => f.rel === RECOVERY_AUTHORITY);
  if (!projection) return out;
  if (!projection.content.includes("from './reason-copy.js'")) {
    out.push({
      rel: RECOVERY_AUTHORITY,
      line: 1,
      snippet: 'missing reason-copy import',
      rule: 'copy-authority-not-derived',
    });
  }
  if (!projection.content.includes('lookupReasonCopy')) {
    out.push({
      rel: RECOVERY_AUTHORITY,
      line: 1,
      snippet: 'missing lookupReasonCopy usage',
      rule: 'copy-authority-not-derived',
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

  it('reason-projection derives migrated copy through the copy authority', () => {
    const violations = findCopyDerivationViolations(files);
    if (violations.length > 0) {
      console.error('Copy-authority derivation violations:', violations);
    }
    expect(violations).toEqual([]);
  });

  it('no parallel per-code impact map exists outside the copy authority', () => {
    const violations = findImpactMapViolations(files);
    if (violations.length > 0) {
      console.error('Parallel impact-map violations:', violations);
    }
    expect(violations).toEqual([]);
  });

  describe('negative fixtures — prove the detectors fire', () => {
    it('detects a registry consumer inside an integration renderer', () => {
      const fixture: SourceFile[] = [
        {
          rel: 'integration/status-presentation.ts',
          content:
            "import { defaultReasonRegistry } from '../config/reasons.js';\n" +
            'const recovery = defaultReasonRegistry.get("PLAN_REQUIRED")?.recoverySteps;',
        },
      ];
      const violations = findRegistryViolations(fixture);
      expect(violations).toHaveLength(2);
      expect(violations.every((v) => v.rule === 'duplicate-recovery-authority')).toBe(true);
    });

    it('detects a registry consumer inside a FUTURE integration renderer (pattern-based scope)', () => {
      const fixture: SourceFile[] = [
        {
          rel: 'integration/review-decision-presentation.ts',
          content: "import { formatReason } from '../config/reasons.js';",
        },
      ];
      const violations = findRegistryViolations(fixture);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.rule).toBe('duplicate-recovery-authority');
    });

    it('does NOT scan non-presenter integration modules (legitimate registry consumers)', () => {
      const fixture: SourceFile[] = [
        {
          rel: 'integration/tools/helpers.ts',
          content:
            "import { defaultReasonRegistry } from '../../config/reasons.js';\n" +
            'const r = defaultReasonRegistry.get("PLAN_REQUIRED");',
        },
      ];
      expect(findRegistryViolations(fixture)).toEqual([]);
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
          rel: 'integration/why-presentation.ts',
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

    it('detects a parallel per-code impact map outside the copy authority', () => {
      const fixture: SourceFile[] = [
        {
          rel: 'presentation/rogue-impact.ts',
          content:
            "export const MY_IMPACT = { VALIDATION_EVIDENCE_REQUIRED: impact: 'verification_incomplete' };",
        },
      ];
      const violations = findImpactMapViolations(fixture);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.rule).toBe('parallel-impact-map');
    });

    it('detects an integration renderer inventing its own impact classification', () => {
      const fixture: SourceFile[] = [
        {
          rel: 'integration/status-presentation.ts',
          content:
            "const impact = code === 'PLAN_REQUIRED' ? impact: 'workflow_blocked' : undefined;",
        },
      ];
      const violations = findImpactMapViolations(fixture);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.rule).toBe('parallel-impact-map');
    });

    it('detects reason-projection not deriving copy from the copy authority', () => {
      const fixture: SourceFile[] = [
        {
          rel: RECOVERY_AUTHORITY,
          content:
            "import { defaultReasonRegistry } from '../config/reasons.js';\nexport function projectReasonFromRegistry(code) { return null; }",
        },
      ];
      const violations = findCopyDerivationViolations(fixture);
      expect(violations).toHaveLength(2);
      expect(violations.every((v) => v.rule === 'copy-authority-not-derived')).toBe(true);
    });
  });
});

// ─── Review Decision SSOT ─────────────────────────────────────────────────────

const REVIEW_DECISION_AUTHORITY = 'presentation/review-decision.ts';

/**
 * Detect severity-based blocker classification in presentation/renderer modules.
 * Patterns like: severity === 'critical' ? blocker : risk
 * Merely referencing severity for display grouping is legitimate.
 */
function hasSeverityBlockerLogic(content: string): boolean {
  // Ternary: severity === 'critical' ? blocker : risk
  if (
    /severity\s*===?\s*['"]critical['"]\s*\?/.test(content) ||
    /severity\s*===?\s*['"]major['"]\s*\?/.test(content)
  )
    return true;
  // if/else: if (severity === 'critical') return blocker; else return risk
  if (
    /if\s*\(.*severity\s*===?\s*['"]critical['"]\)/.test(content) ||
    /if\s*\(.*severity\s*===?\s*['"]major['"]\)/.test(content)
  )
    return true;
  return false;
}

/**
 * Detect prose-based blocker/risk classification.
 * Patterns like: message.includes('block'), .startsWith('risk'), regex on finding text.
 */
function hasProseBlockingLogic(content: string): boolean {
  if (/\.message\s*\.\s*includes\(/.test(content)) return true;
  if (/\.message\s*\.\s*startsWith\(/.test(content)) return true;
  if (/\.message\s*\.\s*match\(/.test(content)) return true;
  if (/\.message\s*\.\s*test\(/.test(content)) return true;
  return false;
}

describe('review-decision SSOT', () => {
  const files = collectPresentationFiles();

  it('no module derives blocker/risk from severity outside review-decision authority', () => {
    const violations: string[] = [];
    for (const { rel, content } of files) {
      if (rel === REVIEW_DECISION_AUTHORITY) continue;
      if (!rel.startsWith('presentation/') && !rel.startsWith('integration/')) continue;
      if (hasSeverityBlockerLogic(content)) {
        violations.push(
          `${rel}: derives blocker/risk from severity (severity ≠ blocking authority)`,
        );
      }
    }
    expect(violations).toEqual([]);
  });

  it('no module classifies findings by prose matching', () => {
    const violations: string[] = [];
    for (const { rel, content } of files) {
      if (rel === REVIEW_DECISION_AUTHORITY) continue;
      if (!rel.startsWith('presentation/') && !rel.startsWith('integration/')) continue;
      if (hasProseBlockingLogic(content)) {
        violations.push(`${rel}: classifies findings by prose matching (use structured fields)`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('REVIEW_DECISION_COPY authority is not duplicated', () => {
    const violations: string[] = [];
    const PERMITTED_CONSUMERS = new Set([
      REVIEW_DECISION_AUTHORITY,
      'presentation/review-decision.test.ts',
      'presentation/evidence-review-card.ts',
      'presentation/plan-review-card.ts',
      'presentation/architecture-review-card.ts',
    ]);
    for (const { rel, content } of files) {
      if (PERMITTED_CONSUMERS.has(rel)) continue;
      if (!rel.startsWith('presentation/') && !rel.endsWith('-presentation.ts')) continue;
      if (
        content.includes("'Ready for human decision'") ||
        content.includes("'Not ready for decision'")
      ) {
        violations.push(`${rel}: duplicates review decision copy outside authority`);
      }
    }
    expect(violations).toEqual([]);
  });

  describe('negative fixtures — prove the detectors fire', () => {
    it('detects severity-based blocker logic', () => {
      expect(
        hasSeverityBlockerLogic("if (finding.severity === 'critical') return 'blocker';"),
      ).toBe(true);
    });

    it('detects prose-based finding classification', () => {
      expect(hasProseBlockingLogic('if (finding.message.includes("block")) return true;')).toBe(
        true,
      );
    });

    it('does NOT flag legitimate structured-field access', () => {
      expect(hasSeverityBlockerLogic('const severity = finding.severity;')).toBe(false);
    });
  });
});

function collectPresentationFiles(): { rel: string; content: string }[] {
  const files: { rel: string; content: string }[] = [];
  collectFiles(SRC_ROOT, files);
  return files;
}

// ─── ActionIntent SSOT ───────────────────────────────────────────────────────

describe('ActionIntent SSOT', () => {
  const files = collectPresentationFiles();

  it('/continue must not be assigned an ActionIntent', () => {
    for (const { rel, content } of files) {
      if (!rel.includes('installed-commands.ts')) continue;
      const continueBlock = content.match(/\/continue[\s\S]{0,400}?},{0,1}/);
      if (continueBlock) {
        expect(continueBlock[0]).not.toContain('intent:');
      }
    }
  });

  it('no invocation-based semantic branching in presentation modules', () => {
    const violations: string[] = [];
    for (const { rel, content } of files) {
      if (!rel.startsWith('presentation/')) continue;
      // Detect semantic interpretation of invocation strings
      if (
        /invocation\s*===?\s*['"]\/approve['"]/.test(content) ||
        /invocation\s*===?\s*['"]\/reject['"]/.test(content) ||
        /invocation\s*===?\s*['"]\/validate['"]/.test(content) ||
        /invocation\s*\.startsWith\(/.test(content)
      ) {
        violations.push(`${rel}: derives semantics from invocation string (use intent instead)`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('no intent-to-command synthesis in presentation layer', () => {
    const violations: string[] = [];
    for (const { rel, content } of files) {
      if (!rel.startsWith('presentation/')) continue;
      // Detect intent used to synthesize commands
      if (
        /intent\s*===?\s*['"]approve['"]/.test(content) ||
        /intent\s*===?\s*['"]reject['"]/.test(content)
      ) {
        violations.push(`${rel}: uses intent to synthesize commands (intent is metadata only)`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('no StatusActionProjection type remains', () => {
    const violations: string[] = [];
    for (const { rel, content } of files) {
      if (rel.includes('.test.')) continue;
      if (content.includes('interface StatusActionProjection')) {
        violations.push(`${rel}: defines StatusActionProjection (use PresentationAction)`);
      }
    }
    expect(violations).toEqual([]);
  });
});

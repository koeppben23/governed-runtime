/**
 * @module architecture/type-aware-lint-scope
 * @description Default-deny guard for the default-wide lint scope.
 *
 * The type-aware correctness rules (`await-thenable`, `no-floating-promises`,
 * `no-unnecessary-type-assertion`, `no-misused-promises`,
 * `switch-exhaustiveness-check`) apply to EVERY TypeScript file under `src/`,
 * including tests. The maintainability metrics (`complexity`, `max-params`,
 * `max-lines-per-function`) apply to every PRODUCTION file; test suites are the
 * only excluded file class. This guard enumerates the complete file set — no
 * directory sampling, no `__` exclusions — and computes the effective ESLint
 * configuration for each file. A file that is ignored, misses a rule, loses
 * type-aware project resolution, or is outside the pinned metric ceilings fails
 * the guard, so a later override cannot carve out a hidden blind spot.
 *
 * The negative fixtures prove the assertion logic fires on a narrowed,
 * non-type-aware, or weakened config.
 *
 * @version v3
 */

import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(join(import.meta.dirname, '..', '..', '..'));
const SRC = join(ROOT, 'src');

/** The default-wide correctness contract this guard pins. */
const REQUIRED_RULES = [
  '@typescript-eslint/await-thenable',
  '@typescript-eslint/no-floating-promises',
  '@typescript-eslint/no-unnecessary-type-assertion',
  '@typescript-eslint/no-misused-promises',
  '@typescript-eslint/switch-exhaustiveness-check',
] as const;

/**
 * The default-wide metrics contract for production files. Test suites are the
 * only excluded file class — never a directory. The ceilings are the measured
 * repository values (PR 2b); tightening them is a deliberate guard change and
 * weakening them requires one too.
 */
const METRICS_CONTRACT = [
  { rule: 'complexity', option: 'max', value: 25 },
  { rule: 'max-params', option: 'max', value: 5 },
  { rule: 'max-lines-per-function', option: 'max', value: 120 },
] as const;

interface EffectiveConfig {
  readonly rules?: Record<string, unknown>;
  readonly languageOptions?: {
    readonly parserOptions?: Record<string, unknown>;
  };
}

/** Normalize an ESLint rule entry to its severity number. */
function severityOf(entry: unknown): number {
  const level = Array.isArray(entry) ? entry[0] : entry;
  if (level === 'error') return 2;
  if (level === 'warn') return 1;
  return typeof level === 'number' ? level : 0;
}

/** Rules from the default-wide contract that the config does not enforce. */
function missingCorrectnessRules(config: EffectiveConfig): string[] {
  return REQUIRED_RULES.filter((rule) => severityOf(config.rules?.[rule]) < 2);
}

/**
 * The only metric exclusion class: test suites (allowed to be broader).
 * Mirrors the metric `ignores` patterns in `eslint.config.mjs` exactly — a
 * divergence between this classifier and the config is a guard bug.
 */
function isTestFileClass(fileRel: string): boolean {
  return fileRel.endsWith('.test.ts') || fileRel.includes('/__tests__/');
}

function ruleOptions(entry: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(entry)) return undefined;
  const options: unknown = entry[1];
  if (typeof options !== 'object' || options === null) return undefined;
  return options as Record<string, unknown>;
}

/** Metric-contract violations for one production file. */
function metricProblems(config: EffectiveConfig, fileRel: string): string[] {
  const problems: string[] = [];
  for (const { rule, option, value } of METRICS_CONTRACT) {
    const entry = config.rules?.[rule];
    if (severityOf(entry) < 1) {
      problems.push(`${fileRel}: metrics rule ${rule} not enabled`);
      continue;
    }
    const options = ruleOptions(entry);
    if (options?.[option] !== value) {
      problems.push(
        `${fileRel}: ${rule} ${option} is ${String(options?.[option])}, expected ${value}`,
      );
    }
  }
  return problems;
}

/**
 * Whether the config resolves files through a TypeScript project.
 *
 * Deliberately strict: `projectService: false` and `project: []` are not
 * type-aware coverage, and must not satisfy the contract.
 */
function hasTypeAwareParserOptions(config: EffectiveConfig): boolean {
  const parserOptions = config.languageOptions?.parserOptions;
  if (!parserOptions) return false;
  return (
    parserOptions.projectService === true ||
    (Array.isArray(parserOptions.project) && parserOptions.project.length > 0)
  );
}

/** Every `.ts` file under `dir`, recursively — the complete protected set. */
function collectTypeScriptFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.includes('node_modules')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

function rel(file: string): string {
  return relative(ROOT, file);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('lint scope (default-wide correctness and metrics)', () => {
  const eslint = new ESLint({ cwd: ROOT });
  const files = collectTypeScriptFiles(SRC);

  it('enforces the correctness contract for every TypeScript file under src/', async () => {
    const problems: string[] = [];
    for (const file of files) {
      const fileRel = rel(file);
      if (await eslint.isPathIgnored(file)) {
        problems.push(`${fileRel}: ignored by ESLint`);
        continue;
      }
      const config = (await eslint.calculateConfigForFile(file)) as EffectiveConfig;
      const missing = missingCorrectnessRules(config);
      if (missing.length > 0) problems.push(`${fileRel}: missing ${missing.join(', ')}`);
      if (!hasTypeAwareParserOptions(config)) problems.push(`${fileRel}: not type-aware`);
    }
    expect(problems).toEqual([]);
  });

  it('enforces the metrics contract for every production file under src/', async () => {
    const problems: string[] = [];
    for (const file of files) {
      const fileRel = rel(file);
      if (isTestFileClass(fileRel)) continue;
      if (await eslint.isPathIgnored(file)) {
        problems.push(`${fileRel}: ignored by ESLint`);
        continue;
      }
      const config = (await eslint.calculateConfigForFile(file)) as EffectiveConfig;
      problems.push(...metricProblems(config, fileRel));
    }
    expect(problems).toEqual([]);
  });

  it('covers the file classes that a directory allowlist historically skipped (guard is not vacuous)', () => {
    const rels = files.map(rel);
    expect(rels.length).toBeGreaterThan(0);
    // `__tests__` trees, suite-name variants, and root-level files are part of
    // the protected set — the classes most likely to be silently excluded.
    expect(rels.some((p) => p.includes('/__tests__/'))).toBe(true);
    expect(rels.some((p) => p.endsWith('.fuzz.test.ts'))).toBe(true);
    expect(rels.some((p) => p.endsWith('/index.ts'))).toBe(true);
    expect(rels.some((p) => !isTestFileClass(p))).toBe(true);
  });

  describe('negative fixtures — prove the assertion logic fires', () => {
    const narrowed: EffectiveConfig = {
      rules: { '@typescript-eslint/no-floating-promises': 'error' },
      languageOptions: {},
    };

    it('detects a config that only enforces some correctness rules', () => {
      const missing = missingCorrectnessRules(narrowed);
      expect(missing).toHaveLength(4);
      expect(missing).toContain('@typescript-eslint/no-unnecessary-type-assertion');
    });

    it('detects configs that are not actually type-aware', () => {
      expect(hasTypeAwareParserOptions(narrowed)).toBe(false);
      expect(hasTypeAwareParserOptions({ languageOptions: { parserOptions: {} } })).toBe(false);
      expect(
        hasTypeAwareParserOptions({
          languageOptions: { parserOptions: { projectService: false } },
        }),
      ).toBe(false);
      expect(
        hasTypeAwareParserOptions({ languageOptions: { parserOptions: { project: [] } } }),
      ).toBe(false);
    });

    it('accepts the full contract via project and via projectService', () => {
      const rules = Object.fromEntries(
        REQUIRED_RULES.map((rule) => [
          rule,
          rule === '@typescript-eslint/no-misused-promises'
            ? ['error', { checksVoidReturn: false }]
            : 'error',
        ]),
      );
      expect(missingCorrectnessRules({ rules })).toEqual([]);
      expect(
        hasTypeAwareParserOptions({
          languageOptions: { parserOptions: { project: ['./tsconfig.json'] } },
        }),
      ).toBe(true);
      expect(
        hasTypeAwareParserOptions({ languageOptions: { parserOptions: { projectService: true } } }),
      ).toBe(true);
    });

    it('detects a production file outside the metrics contract', () => {
      const incomplete: EffectiveConfig = {
        rules: { complexity: ['warn', { max: 25 }] },
        languageOptions: {},
      };
      const problems = metricProblems(incomplete, 'src/example.ts');
      expect(problems).toContain('src/example.ts: metrics rule max-params not enabled');
      expect(problems).toContain('src/example.ts: metrics rule max-lines-per-function not enabled');
    });

    it('detects weakened metric ceilings', () => {
      const weakened: EffectiveConfig = {
        rules: {
          complexity: ['warn', { max: 40 }],
          'max-params': ['warn', { max: 5 }],
          'max-lines-per-function': ['warn', { max: 120 }],
        },
        languageOptions: {},
      };
      expect(metricProblems(weakened, 'src/example.ts')).toEqual([
        'src/example.ts: complexity max is 40, expected 25',
      ]);
    });

    it('classifies test suites as the only metric exclusion class', () => {
      expect(isTestFileClass('src/a/b.test.ts')).toBe(true);
      expect(isTestFileClass('src/a/__tests__/b.ts')).toBe(true);
      // `.spec.ts` is NOT a test class here: the repo convention and the
      // metric config treat it as production code.
      expect(isTestFileClass('src/a/b.spec.ts')).toBe(false);
      expect(isTestFileClass('src/a/b.ts')).toBe(false);
    });
  });
});

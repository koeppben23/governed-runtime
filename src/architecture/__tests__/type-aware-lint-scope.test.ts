/**
 * @module architecture/type-aware-lint-scope
 * @description Default-deny guard for the type-aware correctness lint scope.
 *
 * The type-aware correctness rules (`await-thenable`, `no-floating-promises`,
 * `no-unnecessary-type-assertion`, `no-misused-promises`,
 * `switch-exhaustiveness-check`) apply to EVERY TypeScript file under `src/`,
 * including tests. This guard enumerates the complete file set — no directory
 * sampling, no `__` exclusions — and computes the effective ESLint
 * configuration for each file. A file that is ignored, misses one of the
 * rules, or loses type-aware project resolution fails the guard, so a later
 * override cannot carve out a hidden blind spot.
 *
 * The negative fixtures prove the assertion logic fires on a narrowed or
 * non-type-aware config.
 *
 * @version v2
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

describe('type-aware lint scope (default-wide correctness)', () => {
  const eslint = new ESLint({ cwd: ROOT });
  const files = collectTypeScriptFiles(SRC);

  it('enforces the correctness contract for every TypeScript file under src/', async () => {
    const problems: string[] = [];
    for (const file of files) {
      if (await eslint.isPathIgnored(file)) {
        problems.push(`${rel(file)}: ignored by ESLint`);
        continue;
      }
      const config = (await eslint.calculateConfigForFile(file)) as EffectiveConfig;
      const missing = missingCorrectnessRules(config);
      if (missing.length > 0) problems.push(`${rel(file)}: missing ${missing.join(', ')}`);
      if (!hasTypeAwareParserOptions(config)) problems.push(`${rel(file)}: not type-aware`);
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
  });
});

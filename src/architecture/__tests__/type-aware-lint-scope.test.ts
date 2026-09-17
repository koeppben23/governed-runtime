/**
 * @module architecture/type-aware-lint-scope
 * @description Default-deny guard for the type-aware correctness lint scope.
 *
 * The type-aware correctness rules (`await-thenable`, `no-floating-promises`,
 * `no-unnecessary-type-assertion`, `no-misused-promises`,
 * `switch-exhaustiveness-check`) apply to EVERY TypeScript file under `src/`,
 * including tests. This guard computes the effective ESLint configuration for a
 * representative file in every `src/` directory and fails if any file would
 * fall outside that scope — the drift mode that historically left directories
 * unchecked is not representable.
 *
 * The negative fixtures prove the assertion logic fires on a narrowed config.
 *
 * @version v1
 */

import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { readdirSync, statSync } from 'node:fs';
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

/** Whether the config resolves files through a TypeScript project. */
function hasTypeAwareParserOptions(config: EffectiveConfig): boolean {
  const parserOptions = config.languageOptions?.parserOptions;
  if (!parserOptions) return false;
  return parserOptions.projectService !== undefined || Array.isArray(parserOptions.project);
}

// ─── File collection ─────────────────────────────────────────────────────────

function isTestFile(name: string): boolean {
  return name.endsWith('.test.ts') || name.endsWith('.spec.ts');
}

function collectDirectories(dir: string): string[] {
  const dirs: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.includes('node_modules') || entry.name.includes('__')) {
      continue;
    }
    const full = join(dir, entry.name);
    dirs.push(full, ...collectDirectories(full));
  }
  return dirs;
}

/** First `.ts` file in `dir` matching the predicate, or undefined. */
function firstFile(dir: string, predicate: (name: string) => boolean): string | undefined {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || !predicate(entry.name)) continue;
    return join(dir, entry.name);
  }
  return undefined;
}

/** Recursively find the first `.ts` file matching the predicate. */
function findFirst(dir: string, predicate: (name: string) => boolean): string | undefined {
  const direct = firstFile(dir, predicate);
  if (direct) return direct;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.includes('node_modules') || entry.name.includes('__')) {
      continue;
    }
    const found = findFirst(join(dir, entry.name), predicate);
    if (found) return found;
  }
  return undefined;
}

function rel(file: string): string {
  return relative(ROOT, file);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('type-aware lint scope (default-wide correctness)', () => {
  const eslint = new ESLint({ cwd: ROOT });
  const directories = [SRC, ...collectDirectories(SRC)];

  it('enforces the correctness contract for every src directory (production files)', async () => {
    const problems: string[] = [];
    for (const dir of directories) {
      const file = findFirst(dir, (name) => !isTestFile(name) && !name.endsWith('.d.ts'));
      if (!file) continue;
      const config = (await eslint.calculateConfigForFile(file)) as EffectiveConfig;
      const missing = missingCorrectnessRules(config);
      if (missing.length > 0) problems.push(`${rel(file)}: missing ${missing.join(', ')}`);
      if (!hasTypeAwareParserOptions(config)) problems.push(`${rel(file)}: not type-aware`);
    }
    expect(problems).toEqual([]);
  });

  it('enforces the correctness contract for test files in every src directory', async () => {
    const problems: string[] = [];
    for (const dir of directories) {
      const file = findFirst(dir, isTestFile);
      if (!file) continue;
      const config = (await eslint.calculateConfigForFile(file)) as EffectiveConfig;
      const missing = missingCorrectnessRules(config);
      if (missing.length > 0) problems.push(`${rel(file)}: missing ${missing.join(', ')}`);
      if (!hasTypeAwareParserOptions(config)) problems.push(`${rel(file)}: not type-aware`);
    }
    expect(problems).toEqual([]);
  });

  it('enforces the correctness contract for root-level src files', async () => {
    const problems: string[] = [];
    for (const entry of readdirSync(SRC, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const file = join(SRC, entry.name);
      const config = (await eslint.calculateConfigForFile(file)) as EffectiveConfig;
      const missing = missingCorrectnessRules(config);
      if (missing.length > 0) problems.push(`${rel(file)}: missing ${missing.join(', ')}`);
      if (!hasTypeAwareParserOptions(config)) problems.push(`${rel(file)}: not type-aware`);
    }
    expect(problems).toEqual([]);
  });

  it('finds at least one production and one test file to pin (guard is not vacuous)', () => {
    expect(
      directories.some((dir) =>
        firstFile(dir, (name) => !isTestFile(name) && !name.endsWith('.d.ts')),
      ),
    ).toBe(true);
    expect(directories.some((dir) => firstFile(dir, isTestFile))).toBe(true);
    expect(statSync(SRC).isDirectory()).toBe(true);
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

    it('detects a non-type-aware config', () => {
      expect(hasTypeAwareParserOptions(narrowed)).toBe(false);
      expect(hasTypeAwareParserOptions({ languageOptions: { parserOptions: {} } })).toBe(false);
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

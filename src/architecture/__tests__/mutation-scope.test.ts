/**
 * @module architecture/mutation-scope
 * @description Guards the mutation scope against silent erosion.
 *
 * A path in a Stryker config that no longer resolves does not fail the
 * mutation run — it simply mutates nothing, so the file drops out of the
 * trusted computing base while the gate still reports success. A test path in
 * the Stryker Vitest config that no longer exists has the same failure mode:
 * the suite silently stops running.
 *
 * The assertions below enforce the mutation authority contract defined in
 * `mutation-authority-inventory.ts`:
 *
 * A1 well-formedness: unique `(profile, selector)` identities, existing
 *    targets and covering suites, unambiguous selector forms.
 * A2 required ⊆ mutate: every `required` selector is present in its profile.
 * A3 reverse closure: every mutate entry of every profile has exactly one
 *    `required` inventory entry with the same identity.
 * A4 no unclassified mutate entry: deferred targets and globs are disjoint
 *    from every mutate list.
 * A5 deferral is explicit: deferred entries carry a reason and a valid root.
 * A6 reachability evidence: covering suites are selected by the profile's
 *    Stryker Vitest config, all explicit include paths exist, include globs
 *    match at least one suite, and include/exclude never contradict.
 * A7 provenance: every `required` entry carries either an immutable admission
 *    record at or above the profile break threshold or a legacy baseline.
 * A8 completeness closure: every production source under an authority root is
 *    covered, backlog globs have a non-empty effective set, and no effective
 *    glob file is mutated.
 * A9 count authority: the base required set equals the base mutate list and
 *    the documented `PRODUCT_INVENTORY.mutationFiles` count.
 *
 * These guards are static. They do not measure a mutation score; admission
 * scores are enforced by `scripts/verify-mutation-admission.mjs` from profile
 * full-run reports.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import baseStrykerVitest from '../../../vitest.stryker.config.js';
import humanProjectionVitest from '../../../vitest.stryker-human-projection.config.js';
import identityJwksVitest from '../../../vitest.stryker-identity-jwks.config.js';
import mandatesVitest from '../../../vitest.mandates.config.js';
import { PRODUCT_INVENTORY } from '../../shared/product-inventory.js';
import {
  AUTHORITY_ROOTS,
  MUTATION_AUTHORITY_INVENTORY,
  MUTATION_PROFILES,
  isProductionSource,
  targetOfSelector,
  type MutationProfile,
} from './mutation-authority-inventory.js';

const ROOT = resolve(__dirname, '..', '..', '..');

interface ProfileConfig {
  readonly mutate: readonly string[];
  readonly thresholds?: { readonly break?: number };
}

interface VitestConfig {
  readonly test?: {
    readonly include?: readonly string[];
    readonly exclude?: readonly string[];
  };
}

const PROFILE_VITEST: Readonly<Record<MutationProfile, VitestConfig>> = {
  base: baseStrykerVitest as VitestConfig,
  'human-projection': humanProjectionVitest as VitestConfig,
  'identity-jwks': identityJwksVitest as VitestConfig,
  mandates: mandatesVitest as VitestConfig,
};

function readProfileConfig(profile: MutationProfile): ProfileConfig {
  return JSON.parse(
    readFileSync(join(ROOT, MUTATION_PROFILES[profile].configFile), 'utf-8'),
  ) as ProfileConfig;
}

function profileBreak(profile: MutationProfile): number {
  return readProfileConfig(profile).thresholds?.break ?? 80;
}

function mutateTargets(profile: MutationProfile): Set<string> {
  return new Set(readProfileConfig(profile).mutate.map(targetOfSelector));
}

function mutateSelectors(profile: MutationProfile): Set<string> {
  return new Set(readProfileConfig(profile).mutate);
}

function allMutateTargets(): Set<string> {
  const targets = new Set<string>();
  for (const profile of Object.keys(MUTATION_PROFILES) as MutationProfile[]) {
    for (const target of mutateTargets(profile)) targets.add(target);
  }
  return targets;
}

const DOUBLE_STAR_SLASH = '@@double-star-slash@@';
const DOUBLE_STAR = '@@double-star@@';

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, DOUBLE_STAR_SLASH)
    .replace(/\*\*/g, DOUBLE_STAR)
    .replace(/\*/g, '[^/]*')
    .replaceAll(DOUBLE_STAR_SLASH, '(?:.*/)?')
    .replaceAll(DOUBLE_STAR, '.*');
  return new RegExp(`^${escaped}$`);
}

function matchesAny(relativePath: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(relativePath));
}

function walkFiles(absoluteDir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(absoluteDir)) {
    const full = join(absoluteDir, entry);
    if (statSync(full).isDirectory()) {
      walkFiles(full, out);
    } else {
      out.push(relative(ROOT, full).split(sep).join('/'));
    }
  }
  return out;
}

function expandIncludeGlob(pattern: string): string[] {
  const wildcardIndex = pattern.indexOf('*');
  if (wildcardIndex === -1) return [];
  const staticPrefix = pattern.slice(0, wildcardIndex).replace(/\/$/, '');
  const baseDir = join(ROOT, staticPrefix);
  if (!existsSync(baseDir)) return [];
  const matcher = globToRegExp(pattern);
  return walkFiles(baseDir).filter((file) => matcher.test(file));
}

const requiredEntries = MUTATION_AUTHORITY_INVENTORY.filter(
  (entry) => entry.classification === 'required',
);
const deferredEntries = MUTATION_AUTHORITY_INVENTORY.filter(
  (entry) => entry.classification !== 'required',
);

const exactInventoryTargets = new Set(
  MUTATION_AUTHORITY_INVENTORY.flatMap((entry) => ('root' in entry ? [] : [entry.target])),
);

function effectiveGlobFiles(entry: (typeof MUTATION_AUTHORITY_INVENTORY)[number]): string[] {
  if (!('root' in entry)) return [];
  const baseDir = join(ROOT, entry.root);
  if (!existsSync(baseDir)) return [];
  return walkFiles(baseDir)
    .filter(isProductionSource)
    .filter((file) => !exactInventoryTargets.has(file));
}

describe('mutation scope', () => {
  it('A1: inventory is well-formed and references existing artifacts', () => {
    const identities = requiredEntries.map((entry) => `${entry.profile}:${entry.mutateSelector}`);
    const duplicates = identities.filter(
      (identity, index) => identities.indexOf(identity) !== index,
    );
    expect(duplicates).toEqual([]);

    for (const entry of requiredEntries) {
      expect(existsSync(join(ROOT, entry.target)), `${entry.target} missing`).toBe(true);
      expect(targetOfSelector(entry.mutateSelector)).toBe(entry.target);
      expect(entry.coveringSuites.length).toBeGreaterThan(0);
      for (const suite of entry.coveringSuites) {
        expect(existsSync(join(ROOT, suite)), `${suite} missing`).toBe(true);
      }
    }
  });

  it('A5: deferred entries carry an explicit reason and a valid root', () => {
    const problems: string[] = [];
    for (const entry of deferredEntries) {
      const label = 'root' in entry ? entry.root : entry.target;
      if (entry.reason.trim().length === 0) problems.push(`${label}: empty reason`);
      if ('root' in entry) {
        const rootPath = join(ROOT, entry.root);
        if (!entry.root.startsWith('src/')) problems.push(`${label}: root must live under src/`);
        if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) {
          problems.push(`${label}: root missing or not a directory`);
        }
        if (entry.pattern !== '**') problems.push(`${label}: unsupported deferred pattern`);
      } else if (!existsSync(join(ROOT, entry.target))) {
        problems.push(`${label}: deferred target missing`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('A2: every required selector is in its profile mutate list', () => {
    const missing = requiredEntries
      .filter((entry) => !mutateSelectors(entry.profile).has(entry.mutateSelector))
      .map((entry) => `${entry.profile}: ${entry.mutateSelector}`);
    expect(missing).toEqual([]);
  });

  it('A3: every mutate entry has exactly one required inventory entry', () => {
    const problems: string[] = [];
    for (const profile of Object.keys(MUTATION_PROFILES) as MutationProfile[]) {
      for (const selector of readProfileConfig(profile).mutate) {
        const matches = requiredEntries.filter(
          (entry) => entry.profile === profile && entry.mutateSelector === selector,
        );
        if (matches.length !== 1) {
          problems.push(`${profile}: ${selector} has ${matches.length} inventory entries`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('A4: deferred targets and effective glob files are never mutated', () => {
    const mutated = allMutateTargets();
    const overlap: string[] = [];
    for (const entry of deferredEntries) {
      if ('root' in entry) {
        for (const file of effectiveGlobFiles(entry)) {
          if (mutated.has(file)) overlap.push(`${entry.root}/${entry.pattern}: ${file}`);
        }
      } else if (mutated.has(entry.target)) {
        overlap.push(entry.target);
      }
    }
    expect(overlap).toEqual([]);
  });

  it('A6: covering suites are selected and the include lists are not stale', () => {
    const problems: string[] = [];
    for (const profile of Object.keys(MUTATION_PROFILES) as MutationProfile[]) {
      const config = PROFILE_VITEST[profile].test ?? {};
      const include = config.include ?? [];
      const exclude = config.exclude ?? [];

      const explicitIncludes = include.filter((pattern) => !pattern.includes('*'));
      for (const path of explicitIncludes) {
        if (!existsSync(join(ROOT, path))) problems.push(`${profile}: stale include ${path}`);
        if (matchesAny(path, exclude))
          problems.push(`${profile}: include contradicts exclude ${path}`);
      }
      for (const pattern of include.filter((value) => value.includes('*'))) {
        if (expandIncludeGlob(pattern).length === 0) {
          problems.push(`${profile}: include pattern matches nothing: ${pattern}`);
        }
      }

      for (const entry of requiredEntries.filter((value) => value.profile === profile)) {
        for (const suite of entry.coveringSuites) {
          if (!matchesAny(suite, include) || matchesAny(suite, exclude)) {
            problems.push(`${profile}: ${suite} is not selected for ${entry.mutateSelector}`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('A7: required entries carry admission or legacy provenance', () => {
    const problems: string[] = [];
    for (const entry of requiredEntries) {
      const hasAdmission = entry.admission !== undefined;
      const hasLegacy = entry.legacyBaseline !== undefined;
      if (hasAdmission === hasLegacy) {
        problems.push(
          `${entry.profile}: ${entry.mutateSelector} lacks exactly one provenance record`,
        );
        continue;
      }
      if (entry.admission !== undefined) {
        if (entry.admission.scoreAtAdmission < profileBreak(entry.profile)) {
          problems.push(`${entry.admission.scoreAtAdmission} < break for ${entry.mutateSelector}`);
        }
        if (entry.admission.config !== MUTATION_PROFILES[entry.profile].configFile) {
          problems.push(`${entry.mutateSelector} admission names ${entry.admission.config}`);
        }
      } else if (
        hasLegacy &&
        entry.legacyBaseline?.authorityRef !== MUTATION_PROFILES[entry.profile].configFile
      ) {
        problems.push(`${entry.mutateSelector} legacy baseline names a different config`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('A8: every production file under an authority root is covered by an entry', () => {
    const uncovered: string[] = [];
    const globs = deferredEntries.filter((entry) => 'root' in entry);

    for (const root of AUTHORITY_ROOTS) {
      const baseDir = join(ROOT, root.root);
      if (!existsSync(baseDir)) continue;
      for (const file of walkFiles(baseDir).filter(isProductionSource)) {
        const exact = exactInventoryTargets.has(file);
        const globbed = globs.some(
          (entry) =>
            file.startsWith(`${entry.root}/`) && globToRegExp(`${entry.root}/**`).test(file),
        );
        if (!exact && !globbed) uncovered.push(file);
      }
    }
    expect(uncovered).toEqual([]);

    const emptyGlobs = globs
      .filter((entry) => effectiveGlobFiles(entry).length === 0)
      .map((entry) => `${entry.root}/${entry.pattern}`);
    expect(emptyGlobs).toEqual([]);
  });

  it('A9: the base required set equals the mutate list and the documented count', () => {
    const baseRequired = requiredEntries.filter((entry) => entry.profile === 'base');
    const baseMutate = readProfileConfig('base').mutate;
    expect(baseRequired.length).toBe(baseMutate.length);
    expect(baseRequired.length).toBe(PRODUCT_INVENTORY.mutationFiles);
  });
});

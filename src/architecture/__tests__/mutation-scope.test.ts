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
 *    targets and covering suites, unambiguous selector forms, and an explicit
 *    reason for every admission candidate.
 * A2 mutated ⊆ mutate: every `required` and `admission-candidate` selector is
 *    present in its profile.
 * A3 reverse closure: every mutate entry of every profile has exactly one
 *    `required` or `admission-candidate` inventory entry with that identity.
 * A4 no unclassified mutate entry: backlog targets and globs are disjoint
 *    from every mutate list; `not-mutation-suitable` stays profile-scoped.
 * A5 deferral is explicit: deferred entries carry a reason and a valid root.
 * A6 reachability evidence: covering suites are selected by the profile's
 *    Stryker Vitest config, all explicit include paths exist, include globs
 *    match at least one suite, and include/exclude never contradict.
 * A7 provenance: every `required` entry carries either an immutable admission
 *    record at or above the profile break threshold or a legacy baseline.
 *    Candidates must NOT carry provenance; the full-run verdict decides.
 * A8 completeness closure: every production source under an authority root is
 *    covered, backlog globs have a non-empty effective set, and no effective
 *    glob file is mutated.
 * A9 count authority: the base mutated set (required + candidates) equals the
 *    base mutate list and the documented `PRODUCT_INVENTORY.mutationFiles`
 *    count.
 * A10 registry closure: `scripts/mutation-profile-registry.json`, the profile
 *    union, the on-disk Stryker configs, and the verifier's registry read
 *    cannot drift; report and manifest paths are unique; every config's JSON
 *    reporter writes the registry report path; every admission workflow
 *    enforces the admitted per-target gate.
 * A11 admission reconciliation: the immutable admission records, the active
 *    admission-bearing required entries, and the registry's admitted selector
 *    projection close in both directions; every admitted selector is in its
 *    profile mutate list. Orphaned records or registry drift fail closed.
 *
 * These guards are static. They do not measure a mutation score; admission
 * scores are enforced by `scripts/verify-mutation-admission.mjs` from profile
 * full-run reports.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import baseStrykerVitest from '../../../vitest.stryker.config.js';
import eventCoreVitest from '../../../vitest.stryker-event-core.config.js';
import humanProjectionVitest from '../../../vitest.stryker-human-projection.config.js';
import identityJwksVitest from '../../../vitest.stryker-identity-jwks.config.js';
import mandatesVitest from '../../../vitest.mandates.config.js';
import schemasVitest from '../../../vitest.stryker-schemas.config.js';
import topologyVitest from '../../../vitest.stryker-topology.config.js';
import { PRODUCT_INVENTORY } from '../../shared/product-inventory.js';
import {
  AUTHORITY_ROOTS,
  MUTATION_AUTHORITY_INVENTORY,
  MUTATION_PROFILES,
  assertRequiredProvenance,
  isProductionSource,
  targetOfSelector,
  type AdmissionCandidateEntry,
  type AdmissionRecord,
  type MutationProfile,
} from './mutation-authority-inventory.js';
import { admissionRecord, admissionRecordSelectors } from './mutation-admission-records.js';
import { repoRelative } from './repo-path.js';

const ROOT = resolve(__dirname, '..', '..', '..');

interface MutationProfileRegistryEntry {
  readonly configFile: string;
  readonly vitestConfigFile: string;
  readonly reportPath: string;
  readonly manifestPath: string;
  readonly admittedSelectors?: readonly string[];
}

interface MutationProfileRegistry {
  readonly version: number;
  readonly profiles: Readonly<Record<string, MutationProfileRegistryEntry>>;
}

function readRegistry(): MutationProfileRegistry {
  return JSON.parse(
    readFileSync(join(ROOT, 'scripts', 'mutation-profile-registry.json'), 'utf-8'),
  ) as MutationProfileRegistry;
}

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
  base: baseStrykerVitest,
  'event-core': eventCoreVitest,
  'human-projection': humanProjectionVitest,
  'identity-jwks': identityJwksVitest,
  mandates: mandatesVitest,
  schemas: schemasVitest,
  topology: topologyVitest,
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
      out.push(repoRelative(ROOT, full));
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
const candidateEntries = MUTATION_AUTHORITY_INVENTORY.filter(
  (entry): entry is AdmissionCandidateEntry => entry.classification === 'admission-candidate',
);
const mutatedAuthorityEntries = [...requiredEntries, ...candidateEntries];
const deferredEntries = MUTATION_AUTHORITY_INVENTORY.filter(
  (entry) =>
    entry.classification === 'admission-backlog' ||
    entry.classification === 'not-mutation-suitable',
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
    const identities = mutatedAuthorityEntries.map(
      (entry) => `${entry.profile}:${entry.mutateSelector}`,
    );
    const duplicates = identities.filter(
      (identity, index) => identities.indexOf(identity) !== index,
    );
    expect(duplicates).toEqual([]);

    for (const entry of mutatedAuthorityEntries) {
      expect(existsSync(join(ROOT, entry.target)), `${entry.target} missing`).toBe(true);
      expect(targetOfSelector(entry.mutateSelector)).toBe(entry.target);
      expect(entry.coveringSuites.length).toBeGreaterThan(0);
      for (const suite of entry.coveringSuites) {
        expect(existsSync(join(ROOT, suite)), `${suite} missing`).toBe(true);
      }
    }

    for (const entry of candidateEntries) {
      expect(entry.reason.trim().length, `${entry.mutateSelector} lacks a reason`).toBeGreaterThan(
        0,
      );
      expect('admission' in entry, `${entry.mutateSelector} candidate carries admission`).toBe(
        false,
      );
      expect(
        'legacyBaseline' in entry,
        `${entry.mutateSelector} candidate carries legacy provenance`,
      ).toBe(false);
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
      } else {
        if (!existsSync(join(ROOT, entry.target))) {
          problems.push(`${label}: deferred target missing`);
        }
        if (entry.classification === 'not-mutation-suitable' && entry.profile === undefined) {
          problems.push(`${label}: not-mutation-suitable must name the profile it was measured in`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('A2: every required or candidate selector is in its profile mutate list', () => {
    const missing = mutatedAuthorityEntries
      .filter((entry) => !mutateSelectors(entry.profile).has(entry.mutateSelector))
      .map((entry) => `${entry.profile}: ${entry.mutateSelector}`);
    expect(missing).toEqual([]);
  });

  it('A3: every mutate entry has exactly one required or candidate inventory entry', () => {
    const problems: string[] = [];
    for (const profile of Object.keys(MUTATION_PROFILES) as MutationProfile[]) {
      for (const selector of readProfileConfig(profile).mutate) {
        const matches = mutatedAuthorityEntries.filter(
          (entry) => entry.profile === profile && entry.mutateSelector === selector,
        );
        if (matches.length !== 1) {
          problems.push(`${profile}: ${selector} has ${matches.length} inventory entries`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('A4: deferred targets are never mutated in their declared scope', () => {
    const mutatedAnywhere = allMutateTargets();
    const overlap: string[] = [];
    for (const entry of deferredEntries) {
      if ('root' in entry) {
        for (const file of effectiveGlobFiles(entry)) {
          if (mutatedAnywhere.has(file)) overlap.push(`${entry.root}/${entry.pattern}: ${file}`);
        }
        continue;
      }
      // A target classified 'not-mutation-suitable' for one profile may still
      // be a legitimate target in another profile; the exclusion is scoped.
      let scope: Set<string>;
      if (entry.classification === 'not-mutation-suitable') {
        scope = mutateTargets(entry.profile);
      } else if (entry.profile !== undefined) {
        scope = mutateTargets(entry.profile);
      } else {
        scope = mutatedAnywhere;
      }
      if (scope.has(entry.target)) overlap.push(`${entry.profile ?? 'all'}: ${entry.target}`);
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

      for (const entry of mutatedAuthorityEntries.filter((value) => value.profile === profile)) {
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

  it('A7: provenance cannot be synthesized implicitly', () => {
    const admission: AdmissionRecord = {
      verifiedAt: '2026-09-19',
      commitSha: '0'.repeat(40),
      scoreAtAdmission: 100,
      killed: 1,
      survived: 0,
      config: 'stryker.conf.json',
    };

    expect(() => assertRequiredProvenance('fixture.ts', {})).toThrow(
      /exactly one of 'admission' or 'legacy: true'/,
    );
    expect(() => assertRequiredProvenance('fixture.ts', { admission, legacy: true })).toThrow(
      /exactly one of 'admission' or 'legacy: true'/,
    );
    expect(() => assertRequiredProvenance('fixture.ts', { legacy: true })).not.toThrow();
    expect(() => assertRequiredProvenance('fixture.ts', { admission })).not.toThrow();
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

  it('A9: the base mutated set equals the mutate list and the documented count', () => {
    const baseMutated = mutatedAuthorityEntries.filter((entry) => entry.profile === 'base');
    const baseMutate = readProfileConfig('base').mutate;
    expect(baseMutated.length).toBe(baseMutate.length);
    expect(baseMutated.length).toBe(PRODUCT_INVENTORY.mutationFiles);
  });

  it('A10: the profile registry closes over inventory, configs, reporters, and the verifier', () => {
    const registry = readRegistry();

    const registryIds = Object.keys(registry.profiles).sort();
    const inventoryIds = (Object.keys(MUTATION_PROFILES) as MutationProfile[]).sort();
    expect(registryIds, 'registry and inventory profile sets differ').toEqual(inventoryIds);
    expect(
      Object.keys(PROFILE_VITEST).sort(),
      'PROFILE_VITEST does not cover the registry',
    ).toEqual(registryIds);

    const onDiskConfigs = readdirSync(ROOT)
      .filter((name) => /^stryker(\..+)?\.conf\.json$/.test(name))
      .sort();
    expect(onDiskConfigs, 'orphan or missing Stryker config').toEqual(
      registryIds.map((id) => registry.profiles[id]?.configFile).sort(),
    );

    const reportPaths = new Set<string>();
    const manifestPaths = new Set<string>();
    for (const id of registryIds) {
      const entry = registry.profiles[id];
      expect(entry, id).toBeDefined();
      if (entry === undefined) continue;

      expect(existsSync(join(ROOT, entry.configFile)), `${id}: missing config`).toBe(true);
      expect(existsSync(join(ROOT, entry.vitestConfigFile)), `${id}: missing vitest config`).toBe(
        true,
      );
      expect(MUTATION_PROFILES[id as MutationProfile]?.vitestConfigFile, id).toBe(
        entry.vitestConfigFile,
      );

      const config = JSON.parse(readFileSync(join(ROOT, entry.configFile), 'utf-8')) as {
        readonly vitest?: { readonly configFile?: string };
        readonly jsonReporter?: { readonly fileName?: string };
        readonly htmlReporter?: { readonly fileName?: string };
      };
      expect(config.vitest?.configFile, `${id}: vitest config drift`).toBe(entry.vitestConfigFile);
      expect(config.jsonReporter?.fileName, `${id}: JSON reporter path drift`).toBe(
        entry.reportPath,
      );
      expect(config.htmlReporter?.fileName, `${id}: HTML reporter path drift`).toBe(
        entry.reportPath.replace(/\.json$/, '.html'),
      );

      expect(reportPaths.has(entry.reportPath), `${id}: duplicate report path`).toBe(false);
      reportPaths.add(entry.reportPath);
      expect(manifestPaths.has(entry.manifestPath), `${id}: duplicate manifest path`).toBe(false);
      manifestPaths.add(entry.manifestPath);
    }

    const verifier = readFileSync(join(ROOT, 'scripts', 'verify-mutation-admission.mjs'), 'utf-8');
    expect(verifier, 'verifier still owns a private profile map').not.toContain(
      'PROFILE_CONFIG = {',
    );
    expect(verifier, 'verifier does not read the registry').toContain(
      'mutation-profile-registry.json',
    );
    expect(verifier, 'verifier does not consume registry manifest paths').toContain(
      'PROFILE_MANIFEST_PATH',
    );
    expect(verifier, 'verifier duplicates a report or manifest path').not.toContain(
      'reports/mutation/',
    );
    expect(verifier, 'verifier does not implement --require-admitted').toContain(
      '--require-admitted',
    );
    expect(verifier, 'verifier does not read registry admitted selectors').toContain(
      'admittedSelectors',
    );

    const assertSeparateVerifierCommands = (name: string, workflow: string): void => {
      expect(workflow, `${name}: folded scalar around the verifier invocation`).not.toMatch(
        /run: >-[\s\S]{0,600}?verify-mutation-admission/,
      );
      const commandLines = workflow
        .split('\n')
        .filter((line) =>
          line.trimStart().startsWith('node scripts/verify-mutation-admission.mjs'),
        );
      expect(
        commandLines.some((line) => line.includes('--write-profile-manifest')),
        `${name}: --write-profile-manifest is not its own command line`,
      ).toBe(true);
      expect(
        commandLines.some((line) => line.includes('--verify-profile-manifest')),
        `${name}: --verify-profile-manifest is not its own command line`,
      ).toBe(true);
      expect(
        commandLines.some(
          (line) =>
            line.includes('--verify-profile-manifest') && line.includes('--require-admitted'),
        ),
        `${name}: admitted per-target gate missing (--require-admitted)`,
      ).toBe(true);
      expect(
        workflow.indexOf('--write-profile-manifest') <
          workflow.indexOf('--verify-profile-manifest'),
        `${name}: write must precede re-verify`,
      ).toBe(true);
    };

    const focusedWorkflows = [
      'mutation-event-core.yml',
      'mutation-human-projection.yml',
      'mutation-topology.yml',
      'mutation-identity-jwks.yml',
      'mutation-schemas.yml',
      'mandates-semantic-mutation.yml',
    ];
    for (const name of focusedWorkflows) {
      const workflow = readFileSync(join(ROOT, '.github', 'workflows', name), 'utf-8');
      expect(workflow, `${name}: registry manifest write missing`).toContain(
        '--write-profile-manifest',
      );
      expect(workflow, `${name}: registry manifest verify missing`).toContain(
        '--verify-profile-manifest',
      );
      expect(workflow, `${name}: duplicates a report or manifest path`).not.toContain(
        'reports/mutation/',
      );
      expect(workflow, `${name}: verifier missing from path filter`).toContain(
        "'scripts/verify-mutation-admission.mjs'",
      );
      assertSeparateVerifierCommands(name, workflow);
    }
    for (const name of ['mutation.yml', 'release.yml']) {
      const workflow = readFileSync(join(ROOT, '.github', 'workflows', name), 'utf-8');
      expect(workflow, `${name}: registry manifest write missing`).toContain(
        '--write-profile-manifest',
      );
      expect(workflow, `${name}: registry manifest verify missing`).toContain(
        '--verify-profile-manifest',
      );
      assertSeparateVerifierCommands(name, workflow);
    }
  });

  it('A11: admission records, active admissions, and the registry close in both directions', () => {
    const registry = readRegistry();
    const problems: string[] = [];

    const admissionEntries = requiredEntries.filter((entry) => entry.admission !== undefined);
    const referenced = admissionEntries.map((entry) => entry.mutateSelector).sort();
    const recorded = [...admissionRecordSelectors()].sort();

    if (referenced.length !== recorded.length) {
      problems.push(
        `${recorded.length} immutable record(s) vs ${referenced.length} active admission(s)`,
      );
    }
    const recordedSet = new Set(recorded);
    for (const selector of referenced) {
      if (!recordedSet.has(selector)) {
        problems.push(`${selector}: active admission without an immutable record`);
      }
    }
    const referencedSet = new Set(referenced);
    for (const selector of recorded) {
      if (!referencedSet.has(selector)) {
        problems.push(`${selector}: immutable record without an active admission`);
      }
    }

    for (const profile of Object.keys(MUTATION_PROFILES) as MutationProfile[]) {
      const declared = registry.profiles[profile]?.admittedSelectors;
      if (declared === undefined) {
        problems.push(`${profile}: registry declares no admittedSelectors`);
        continue;
      }
      if (new Set(declared).size !== declared.length) {
        problems.push(`${profile}: admittedSelectors contains duplicates`);
      }
      const expected = admissionEntries
        .filter((entry) => entry.profile === profile)
        .map((entry) => {
          const recordConfig = admissionRecord(entry.mutateSelector).config;
          if (recordConfig !== MUTATION_PROFILES[profile].configFile) {
            problems.push(
              `${entry.mutateSelector}: record config ${recordConfig} != ${MUTATION_PROFILES[profile].configFile}`,
            );
          }
          return entry.mutateSelector;
        })
        .sort();
      if ([...declared].sort().join('\n') !== expected.join('\n')) {
        problems.push(`${profile}: registry admittedSelectors drift from active admissions`);
      }
      for (const selector of declared) {
        if (!mutateSelectors(profile).has(selector)) {
          problems.push(
            `${profile}: admitted selector not in the profile mutate list: ${selector}`,
          );
        }
      }
    }

    expect(problems).toEqual([]);
  });
});

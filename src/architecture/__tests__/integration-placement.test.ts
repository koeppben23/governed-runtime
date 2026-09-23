/**
 * @module architecture/integration-placement
 * @description Enforcement for the positive integration placement authority.
 *
 * The authority (`integration-placement-policy.ts`) is the exact projection of
 * every production file under `src/integration/` with its architectural owner.
 * Zone and target zone are derived (parent directory / owner target) and MUST
 * be equal. This suite proves the projection in BOTH directions against the
 * real tree (no unclassified file, no stale entry), checks the zone/owner
 * registries, classifies test support separately, and fails closed on ANY
 * owner-vs-directory mismatch.
 *
 * Negative fixtures drive the pure analyzer with synthetic inputs so the guard
 * is proven to fire, not merely to accept today's tree.
 *
 * @version v3
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  INTEGRATION_OWNERS,
  INTEGRATION_PLACEMENT,
  INTEGRATION_PLACEMENT_ZONES,
  analyzeIntegrationPlacement,
  isRootCompositionFile,
  isRootHostRuntimeFile,
  isToolCommandContextFile,
  placementOwnerOf,
  type IntegrationOwner,
  type IntegrationPlacementEntry,
  type IntegrationPlacementViolation,
  type IntegrationPlacementZone,
} from './integration-placement-policy.js';
import { isTestSourcePath } from './module-classification.js';
import { collectProductionSources } from './production-source.js';

const SRC = join(process.cwd(), 'src');

const ROOT_OWNERS = new Set(['root-composition', 'root-host-runtime', 'root-authority']);

const OWNER_TARGET_ZONE = new Map(INTEGRATION_OWNERS.map((owner) => [owner.id, owner.targetZone]));

function targetZoneOf(entry: IntegrationPlacementEntry): string | undefined {
  return OWNER_TARGET_ZONE.get(entry.owner);
}

function integrationProductionFiles(): string[] {
  return collectProductionSources(SRC)
    .map((source) => source.rel)
    .filter((rel) => rel.startsWith('integration/'))
    .sort();
}

function analyzeReal(): IntegrationPlacementViolation[] {
  return analyzeIntegrationPlacement({
    productionFiles: integrationProductionFiles(),
    placement: INTEGRATION_PLACEMENT,
    zones: INTEGRATION_PLACEMENT_ZONES,
    owners: INTEGRATION_OWNERS,
    isTestFile: isTestSourcePath,
  });
}

describe('integration placement authority', () => {
  it('projects the exact production file set with zero violations', () => {
    const files = integrationProductionFiles();
    const violations = analyzeReal();
    if (violations.length > 0) {
      console.error(
        '\nintegration placement violations:\n' +
          violations.map((violation) => `  - ${violation.file}: ${violation.message}`).join('\n'),
      );
    }
    expect(violations, JSON.stringify(violations)).toEqual([]);
    expect(files.length).toBe(221);
    expect(INTEGRATION_PLACEMENT.length).toBe(files.length);
    expect(new Set(INTEGRATION_PLACEMENT.map((entry) => entry.file)).size).toBe(files.length);
  });

  it('classifies test support separately and keeps it out of the placement authority', () => {
    const testSupport = [
      'integration/test-helpers.ts',
      'integration/plugin-audit-test-helpers.ts',
      'integration/plugin-host-task-diagnostics-test-helpers.ts',
      'integration/tools/review-validation-test-helpers.ts',
      'integration/review/enforcement/test-helpers.ts',
    ];

    for (const rel of testSupport) {
      expect(existsSync(join(SRC, rel)), rel).toBe(true);
      expect(isTestSourcePath(rel), rel).toBe(true);
      expect(
        INTEGRATION_PLACEMENT.some((entry) => entry.file === rel),
        rel,
      ).toBe(false);
    }
    expect(INTEGRATION_PLACEMENT.every((entry) => !isTestSourcePath(entry.file))).toBe(true);
  });

  it('keeps the zone and owner registries well formed', () => {
    const zoneIds = INTEGRATION_PLACEMENT_ZONES.map((zone) => zone.id);
    expect(new Set(zoneIds).size).toBe(zoneIds.length);
    expect(zoneIds).toContain('root');

    const zoneDirs = INTEGRATION_PLACEMENT_ZONES.map((zone) => zone.dir);
    expect(new Set(zoneDirs).size).toBe(zoneDirs.length);

    const ownerIds = INTEGRATION_OWNERS.map((owner) => owner.id);
    expect(new Set(ownerIds).size).toBe(ownerIds.length);

    for (const owner of INTEGRATION_OWNERS) {
      expect(zoneIds, owner.id).toContain(owner.targetZone);
    }
    for (const zone of INTEGRATION_PLACEMENT_ZONES) {
      expect(zone.dir === 'integration' || zone.dir.startsWith('integration/'), zone.id).toBe(true);
    }
  });

  it('admits only composition, host/runtime wiring, and authorities at the root', () => {
    const rootFiles = INTEGRATION_PLACEMENT.filter((entry) => targetZoneOf(entry) === 'root');
    expect(rootFiles.length).toBeGreaterThan(0);
    for (const entry of rootFiles) {
      expect(ROOT_OWNERS.has(entry.owner), entry.file).toBe(true);
    }
    for (const owner of ROOT_OWNERS) {
      expect(
        rootFiles.some((entry) => entry.owner === owner),
        owner,
      ).toBe(true);
    }
  });

  it('freezes the agreed root matrix exactly (23 + 4 + 13 = 40)', () => {
    const rootFiles = INTEGRATION_PLACEMENT.filter((entry) => targetZoneOf(entry) === 'root');
    const byOwner = (owner: string) => rootFiles.filter((entry) => entry.owner === owner);

    expect(byOwner('root-composition').length).toBe(23);
    expect(byOwner('root-host-runtime').length).toBe(4);
    expect(byOwner('root-authority').length).toBe(13);
    expect(rootFiles.length).toBe(40);

    expect(
      byOwner('root-host-runtime')
        .map((entry) => entry.file)
        .sort(),
    ).toEqual([
      'integration/installed-commands.ts',
      'integration/opencode-host-adapter.ts',
      'integration/runtime-instance.ts',
      'integration/runtime-lease.ts',
    ]);
  });

  it('exposes positive placement helpers for the context boundaries', () => {
    expect(placementOwnerOf('integration/plugin.ts')).toBe('root-composition');
    expect(placementOwnerOf('integration/plugin-helpers.ts')).toBe('root-composition');
    expect(placementOwnerOf('integration/review/dispatch/native-task-review.ts')).toBe(
      'review-dispatch',
    );
    expect(placementOwnerOf('integration/rogue.ts')).toBeNull();

    expect(isRootCompositionFile('integration/plugin-risk.ts')).toBe(true);
    expect(isRootCompositionFile('integration/plugin-helpers.ts')).toBe(true);
    expect(isRootHostRuntimeFile('integration/opencode-host-adapter.ts')).toBe(true);
    expect(isRootHostRuntimeFile('integration/errors.ts')).toBe(false);

    expect(isToolCommandContextFile('integration/tools/plan/plan.ts')).toBe(true);
    expect(isToolCommandContextFile('integration/tools/review-tool/index.ts')).toBe(true);
    expect(isToolCommandContextFile('integration/tools/helpers.ts')).toBe(false);
  });
});

// ─── Negative fixtures — prove the analyzer fires ────────────────────────────

const FIXTURE_ZONES: readonly IntegrationPlacementZone[] = [
  { id: 'root', dir: 'integration', description: 'fixture root' },
  { id: 'status', dir: 'integration/status', description: 'fixture status' },
  { id: 'tools', dir: 'integration/tools', description: 'fixture tools' },
];

const FIXTURE_OWNERS: readonly IntegrationOwner[] = [
  { id: 'root-authority', targetZone: 'root', description: 'fixture root authority' },
  { id: 'status', targetZone: 'status', description: 'fixture status context' },
];

function entry(file: string, owner: string): IntegrationPlacementEntry {
  return { file, owner };
}

function analyzeFixture(input: {
  readonly productionFiles?: readonly string[];
  readonly placement?: readonly IntegrationPlacementEntry[];
  readonly zones?: readonly IntegrationPlacementZone[];
  readonly owners?: readonly IntegrationOwner[];
  readonly testFiles?: readonly string[];
}): string[] {
  const testFiles = new Set(input.testFiles ?? []);
  return analyzeIntegrationPlacement({
    productionFiles: input.productionFiles ?? [],
    placement: input.placement ?? [],
    zones: input.zones ?? FIXTURE_ZONES,
    owners: input.owners ?? FIXTURE_OWNERS,
    isTestFile: (rel) => testFiles.has(rel),
  }).map((violation) => violation.rule);
}

describe('integration placement negative fixtures', () => {
  it('detects an unclassified production file', () => {
    expect(analyzeFixture({ productionFiles: ['integration/rogue.ts'] })).toEqual([
      'unclassified-production-file',
    ]);
  });

  it('detects a stale placement entry', () => {
    expect(
      analyzeFixture({
        placement: [entry('integration/gone.ts', 'root-authority')],
      }),
    ).toEqual(['stale-placement-entry']);
  });

  it('detects a file whose directory is not a known zone', () => {
    expect(
      analyzeFixture({
        productionFiles: ['integration/rogue/x.ts'],
        placement: [entry('integration/rogue/x.ts', 'root-authority')],
      }),
    ).toEqual(['unknown-zone']);
  });

  it('detects an unknown owner', () => {
    expect(
      analyzeFixture({
        productionFiles: ['integration/rogue.ts'],
        placement: [entry('integration/rogue.ts', 'ghost')],
      }),
    ).toEqual(['unknown-owner']);
  });

  it('detects an owner whose target zone is not a known zone', () => {
    expect(
      analyzeFixture({
        productionFiles: ['integration/rogue.ts'],
        placement: [entry('integration/rogue.ts', 'ghost-zone')],
        owners: [
          ...FIXTURE_OWNERS,
          { id: 'ghost-zone', targetZone: 'nowhere', description: 'fixture ghost zone' },
        ],
      }),
    ).toEqual(['unknown-zone']);
  });

  it('detects a file whose directory zone differs from its owner target zone', () => {
    expect(
      analyzeFixture({
        productionFiles: ['integration/status/moved.ts'],
        placement: [entry('integration/status/moved.ts', 'root-authority')],
      }),
    ).toEqual(['zone-owner-mismatch']);
  });

  it('detects a zone that exceeds its production-file budget (and never counts test files)', () => {
    const budgetZones: readonly IntegrationPlacementZone[] = FIXTURE_ZONES.map((zone) =>
      zone.id === 'status' ? { ...zone, maxProductionFiles: 1 } : zone,
    );

    expect(
      analyzeFixture({
        zones: budgetZones,
        productionFiles: ['integration/status/a.ts', 'integration/status/b.ts'],
        placement: [
          entry('integration/status/a.ts', 'status'),
          entry('integration/status/b.ts', 'status'),
        ],
      }),
    ).toEqual(['zone-production-budget-exceeded']);

    expect(
      analyzeFixture({
        zones: budgetZones,
        productionFiles: ['integration/status/a.ts', 'integration/status/rogue.test.ts'],
        placement: [
          entry('integration/status/a.ts', 'status'),
          entry('integration/status/rogue.test.ts', 'status'),
        ],
        testFiles: ['integration/status/rogue.test.ts'],
      }),
    ).toEqual(['test-file-in-placement']);
  });

  it('detects a test file carrying a placement entry', () => {
    expect(
      analyzeFixture({
        productionFiles: ['integration/rogue.test.ts'],
        placement: [entry('integration/rogue.test.ts', 'root-authority')],
        testFiles: ['integration/rogue.test.ts'],
      }),
    ).toEqual(['test-file-in-placement']);
  });

  it('detects duplicate placement entries, zone ids, zone dirs, and owner ids', () => {
    expect(
      analyzeFixture({
        productionFiles: ['integration/rogue.ts'],
        placement: [
          entry('integration/rogue.ts', 'root-authority'),
          entry('integration/rogue.ts', 'root-authority'),
        ],
      }),
    ).toContain('duplicate-placement-entry');

    expect(
      analyzeFixture({
        zones: [...FIXTURE_ZONES, { id: 'root', dir: 'integration', description: 'duplicate' }],
      }),
    ).toContain('duplicate-zone-id');

    expect(
      analyzeFixture({
        zones: [
          ...FIXTURE_ZONES,
          { id: 'status-mirror', dir: 'integration/status', description: 'duplicate dir' },
        ],
      }),
    ).toContain('duplicate-zone-dir');

    expect(
      analyzeFixture({
        owners: [
          ...FIXTURE_OWNERS,
          { id: 'status', targetZone: 'status', description: 'duplicate' },
        ],
      }),
    ).toContain('duplicate-owner-id');
  });

  it('accepts a classified, correctly placed fixture file', () => {
    expect(
      analyzeFixture({
        productionFiles: ['integration/rogue.ts', 'integration/status/kept.ts'],
        placement: [
          entry('integration/rogue.ts', 'root-authority'),
          entry('integration/status/kept.ts', 'status'),
        ],
      }),
    ).toEqual([]);
  });
});

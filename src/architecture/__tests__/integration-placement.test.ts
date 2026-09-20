/**
 * @module architecture/integration-placement
 * @description Enforcement for the positive integration placement authority.
 *
 * The authority (`integration-placement-policy.ts`) is the exact projection of
 * every production file under `src/integration/`: owner, current zone, and
 * target zone. This suite proves the projection in BOTH directions against the
 * real tree (no unclassified file, no stale entry), checks the zone/owner
 * registries, classifies test support separately, and ratchets the frozen
 * placement debt: new debt always fails, resolved debt must be removed from
 * `PLACEMENT_DEBT` in the same change.
 *
 * Negative fixtures drive the pure analyzer with synthetic inputs so the guard
 * is proven to fire, not merely to accept today's tree.
 *
 * @version v1
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  INTEGRATION_OWNERS,
  INTEGRATION_PLACEMENT,
  INTEGRATION_PLACEMENT_ZONES,
  PLACEMENT_DEBT,
  analyzeIntegrationPlacement,
  type IntegrationOwner,
  type IntegrationPlacementEntry,
  type IntegrationPlacementViolation,
  type IntegrationPlacementZone,
} from './integration-placement-policy.js';
import { isTestSourcePath } from './module-classification.js';
import { collectProductionSources } from './production-source.js';

const SRC = join(process.cwd(), 'src');

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
    debt: PLACEMENT_DEBT,
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
    expect(files.length).toBe(215);
    expect(INTEGRATION_PLACEMENT.length).toBe(files.length);
    expect(new Set(INTEGRATION_PLACEMENT.map((entry) => entry.file)).size).toBe(files.length);
  });

  it('freezes the placement debt baseline exactly', () => {
    const observedDebt = INTEGRATION_PLACEMENT.filter((entry) => entry.zone !== entry.targetZone)
      .map((entry) => entry.file)
      .sort();

    expect(observedDebt).toEqual([...PLACEMENT_DEBT].sort());
    expect(PLACEMENT_DEBT.length).toBe(65);
    expect(new Set(PLACEMENT_DEBT).size).toBe(PLACEMENT_DEBT.length);
  });

  it('classifies test support separately and keeps it out of the placement authority', () => {
    const testSupport = [
      'integration/test-helpers.ts',
      'integration/plugin-audit-test-helpers.ts',
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

    const ownerIds = INTEGRATION_OWNERS.map((owner) => owner.id);
    expect(new Set(ownerIds).size).toBe(ownerIds.length);

    for (const owner of INTEGRATION_OWNERS) {
      expect(zoneIds, owner.id).toContain(owner.targetZone);
    }
    for (const zone of INTEGRATION_PLACEMENT_ZONES) {
      expect(zone.dir === 'integration' || zone.dir.startsWith('integration/'), zone.id).toBe(true);
    }
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

function entry(
  file: string,
  owner: string,
  zone: string,
  targetZone: string,
): IntegrationPlacementEntry {
  return { file, owner, zone, targetZone };
}

function analyzeFixture(input: {
  readonly productionFiles?: readonly string[];
  readonly placement?: readonly IntegrationPlacementEntry[];
  readonly zones?: readonly IntegrationPlacementZone[];
  readonly owners?: readonly IntegrationOwner[];
  readonly debt?: readonly string[];
  readonly testFiles?: readonly string[];
}): string[] {
  const testFiles = new Set(input.testFiles ?? []);
  return analyzeIntegrationPlacement({
    productionFiles: input.productionFiles ?? [],
    placement: input.placement ?? [],
    zones: input.zones ?? FIXTURE_ZONES,
    owners: input.owners ?? FIXTURE_OWNERS,
    debt: input.debt ?? [],
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
        placement: [entry('integration/gone.ts', 'root-authority', 'root', 'root')],
      }),
    ).toEqual(['stale-placement-entry']);
  });

  it('detects an unknown zone', () => {
    expect(
      analyzeFixture({
        productionFiles: ['integration/rogue.ts'],
        placement: [entry('integration/rogue.ts', 'root-authority', 'nowhere', 'root')],
      }),
    ).toContain('unknown-zone');
  });

  it('detects an unknown owner', () => {
    expect(
      analyzeFixture({
        productionFiles: ['integration/rogue.ts'],
        placement: [entry('integration/rogue.ts', 'ghost', 'root', 'root')],
      }),
    ).toEqual(['unknown-owner']);
  });

  it('detects an owner target zone mismatch', () => {
    expect(
      analyzeFixture({
        productionFiles: ['integration/rogue.ts'],
        placement: [entry('integration/rogue.ts', 'status', 'root', 'root')],
      }),
    ).toEqual(['owner-target-mismatch']);
  });

  it('detects a zone that does not match the physical directory', () => {
    expect(
      analyzeFixture({
        productionFiles: ['integration/rogue.ts'],
        placement: [entry('integration/rogue.ts', 'root-authority', 'status', 'status')],
      }),
    ).toContain('zone-directory-mismatch');
  });

  it('detects new placement debt', () => {
    expect(
      analyzeFixture({
        productionFiles: ['integration/rogue.ts'],
        placement: [entry('integration/rogue.ts', 'status', 'root', 'status')],
      }),
    ).toEqual(['new-placement-debt']);
  });

  it('detects debt that must be removed after a move', () => {
    expect(
      analyzeFixture({
        productionFiles: ['integration/rogue.ts'],
        placement: [entry('integration/rogue.ts', 'root-authority', 'root', 'root')],
        debt: ['integration/rogue.ts'],
      }),
    ).toEqual(['stale-placement-debt']);
  });

  it('detects a test file carrying a placement entry', () => {
    expect(
      analyzeFixture({
        productionFiles: ['integration/rogue.test.ts'],
        placement: [entry('integration/rogue.test.ts', 'root-authority', 'root', 'root')],
        testFiles: ['integration/rogue.test.ts'],
      }),
    ).toEqual(['test-file-in-placement']);
  });

  it('detects duplicate placement entries, zone ids, and owner ids', () => {
    expect(
      analyzeFixture({
        productionFiles: ['integration/rogue.ts'],
        placement: [
          entry('integration/rogue.ts', 'root-authority', 'root', 'root'),
          entry('integration/rogue.ts', 'root-authority', 'root', 'root'),
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
          entry('integration/rogue.ts', 'root-authority', 'root', 'root'),
          entry('integration/status/kept.ts', 'status', 'status', 'status'),
        ],
      }),
    ).toEqual([]);
  });
});

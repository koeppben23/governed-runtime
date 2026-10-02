/**
 * @module architecture/integration-placement-analyzer
 * @description Derived lookup and default-deny analysis for the integration
 * placement manifest.
 */

import {
  INTEGRATION_OWNERS,
  INTEGRATION_PLACEMENT,
  type IntegrationOwner,
  type IntegrationPlacementEntry,
  type IntegrationPlacementZone,
} from './integration-placement-manifest.js';

const PLACEMENT_BY_FILE = new Map(INTEGRATION_PLACEMENT.map((entry) => [entry.file, entry]));
const OWNER_BY_ID = new Map(INTEGRATION_OWNERS.map((owner) => [owner.id, owner]));

/** Placement owner of a file, or null when the file has no placement entry. */
export function placementOwnerOf(file: string): string | null {
  return PLACEMENT_BY_FILE.get(file)?.owner ?? null;
}

/** True when the file is plugin composition (index.ts, plugin.ts, plugin-*). */
export function isRootCompositionFile(file: string): boolean {
  return placementOwnerOf(file) === 'root-composition';
}

/** True when the file is host/runtime wiring that contexts must not import. */
export function isRootHostRuntimeFile(file: string): boolean {
  return placementOwnerOf(file) === 'root-host-runtime';
}

/** True when the file is a tool command context (`tools/<context>/**`). */
export function isToolCommandContextFile(file: string): boolean {
  const owner = placementOwnerOf(file);
  if (owner === null) return false;
  return OWNER_BY_ID.get(owner)?.targetZone.startsWith('tools/') ?? false;
}

export interface IntegrationPlacementViolation {
  readonly rule: string;
  readonly file: string;
  readonly message: string;
  readonly hint?: string;
}

export interface IntegrationPlacementAnalysisInput {
  readonly productionFiles: readonly string[];
  readonly placement: readonly IntegrationPlacementEntry[];
  readonly zones: readonly IntegrationPlacementZone[];
  readonly owners: readonly IntegrationOwner[];
  readonly isTestFile: (rel: string) => boolean;
}

export function analyzeIntegrationPlacement(
  input: IntegrationPlacementAnalysisInput,
): IntegrationPlacementViolation[] {
  const violations: IntegrationPlacementViolation[] = [];
  const production = new Set(input.productionFiles);
  const zoneById = new Map<string, IntegrationPlacementZone>();
  const zoneByDir = new Map<string, IntegrationPlacementZone>();
  for (const zone of input.zones) {
    if (zoneById.has(zone.id)) {
      violations.push({
        rule: 'duplicate-zone-id',
        file: zone.id,
        message: 'duplicate zone id',
        hint: `Keep exactly one INTEGRATION_PLACEMENT_ZONES entry for zone id '${zone.id}'.`,
      });
    }
    zoneById.set(zone.id, zone);
    if (zoneByDir.has(zone.dir)) {
      violations.push({
        rule: 'duplicate-zone-dir',
        file: zone.dir,
        message: 'duplicate zone directory',
        hint: `Give every zone a unique physical dir; '${zone.dir}' is registered twice in INTEGRATION_PLACEMENT_ZONES.`,
      });
    }
    zoneByDir.set(zone.dir, zone);
  }
  const ownerById = new Map<string, IntegrationOwner>();
  for (const owner of input.owners) {
    if (ownerById.has(owner.id)) {
      violations.push({
        rule: 'duplicate-owner-id',
        file: owner.id,
        message: 'duplicate owner id',
        hint: `Keep exactly one INTEGRATION_OWNERS entry for owner '${owner.id}'.`,
      });
    }
    ownerById.set(owner.id, owner);
  }
  const placementByFile = new Map<string, IntegrationPlacementEntry>();
  for (const entry of input.placement) {
    if (placementByFile.has(entry.file)) {
      violations.push({
        rule: 'duplicate-placement-entry',
        file: entry.file,
        message: 'duplicate placement entry',
        hint: `Keep exactly one { file, owner } INTEGRATION_PLACEMENT entry for '${entry.file}'.`,
      });
    }
    placementByFile.set(entry.file, entry);
  }
  for (const file of input.productionFiles) {
    if (!placementByFile.has(file)) {
      violations.push({
        rule: 'unclassified-production-file',
        file,
        message: 'production file has no placement entry',
        hint: `Add { file: '${file}', owner: '<owner>' } to INTEGRATION_PLACEMENT; the owner's targetZone must match the physical directory.`,
      });
    }
  }
  for (const entry of input.placement) {
    if (!production.has(entry.file)) {
      violations.push({
        rule: 'stale-placement-entry',
        file: entry.file,
        message: 'placement entry has no production file',
        hint: `Remove the INTEGRATION_PLACEMENT entry for '${entry.file}' or restore the file at that path.`,
      });
    }
    if (input.isTestFile(entry.file)) {
      violations.push({
        rule: 'test-file-in-placement',
        file: entry.file,
        message: 'test support must not carry a placement entry',
        hint: 'Remove the placement entry; test support is classified in module-classification.ts, not in the placement authority.',
      });
      continue;
    }
    const owner = ownerById.get(entry.owner);
    if (!owner) {
      violations.push({
        rule: 'unknown-owner',
        file: entry.file,
        message: 'unknown owner ' + entry.owner,
        hint: `Use an id from INTEGRATION_OWNERS or register owner '${entry.owner}' there with a registered targetZone.`,
      });
      continue;
    }
    const requiredZone = zoneById.get(owner.targetZone);
    if (!requiredZone) {
      violations.push({
        rule: 'unknown-zone',
        file: entry.file,
        message: 'unknown target zone ' + owner.targetZone,
        hint: `Point owner '${entry.owner}' at a registered zone in INTEGRATION_PLACEMENT_ZONES.`,
      });
      continue;
    }
    const parent = entry.file.split('/').slice(0, -1).join('/');
    const physicalZone = zoneByDir.get(parent);
    if (!physicalZone) {
      violations.push({
        rule: 'unknown-zone',
        file: entry.file,
        message: 'directory ' + parent + ' is not a known zone',
        hint: `Register zone '${parent}' in INTEGRATION_PLACEMENT_ZONES or move the file into a registered zone directory.`,
      });
      continue;
    }
    if (physicalZone.id !== requiredZone.id) {
      violations.push({
        rule: 'zone-owner-mismatch',
        file: entry.file,
        message:
          'owner ' +
          entry.owner +
          ' requires zone ' +
          requiredZone.id +
          ', but the file is in ' +
          physicalZone.id,
        hint: `Move the file into '${requiredZone.dir}' (the owner's targetZone) or change the owner's targetZone deliberately.`,
      });
    }
  }
  const zoneFileCount = new Map<string, number>();
  for (const entry of input.placement) {
    if (input.isTestFile(entry.file)) continue;
    const owner = ownerById.get(entry.owner);
    if (!owner) continue;
    zoneFileCount.set(owner.targetZone, (zoneFileCount.get(owner.targetZone) ?? 0) + 1);
  }
  for (const zone of input.zones) {
    const exceptions = zone.budgetExceptions ?? [];
    const zoneFiles = new Set<string>();
    for (const entry of input.placement) {
      if (input.isTestFile(entry.file) || !production.has(entry.file)) continue;
      if (ownerById.get(entry.owner)?.targetZone === zone.id) zoneFiles.add(entry.file);
    }
    const seen = new Set<string>();
    const valid = new Set<string>();
    for (const exception of exceptions) {
      if (seen.has(exception.file)) {
        violations.push({
          rule: 'duplicate-zone-budget-exception',
          file: exception.file,
          message: `duplicate budget exception for zone '${zone.id}'`,
          hint: `List '${exception.file}' at most once in budgetExceptions for zone '${zone.id}'.`,
        });
        continue;
      }
      seen.add(exception.file);
      if (exception.reason.trim() === '') {
        violations.push({
          rule: 'zone-budget-exception-reason-missing',
          file: exception.file,
          message: `budget exception for zone '${zone.id}' has an empty reason`,
          hint: `Add a concrete reason to the budgetExceptions entry for '${exception.file}'.`,
        });
      }
      const entry = placementByFile.get(exception.file);
      const owner = entry ? ownerById.get(entry.owner) : undefined;
      if (
        entry &&
        owner &&
        production.has(exception.file) &&
        !input.isTestFile(exception.file) &&
        owner.targetZone !== zone.id
      ) {
        violations.push({
          rule: 'zone-budget-exception-out-of-zone',
          file: exception.file,
          message: `budget exception '${exception.file}' belongs to zone '${owner.targetZone}', not '${zone.id}'`,
          hint: `Move the exception to zone '${owner.targetZone}' or remove it.`,
        });
        continue;
      }
      if (!zoneFiles.has(exception.file)) {
        violations.push({
          rule: 'stale-zone-budget-exception',
          file: exception.file,
          message: `budget exception '${exception.file}' is not a production file in zone '${zone.id}'`,
          hint: `Remove the budgetExceptions entry, or restore/move the file into zone '${zone.id}'.`,
        });
        continue;
      }
      valid.add(exception.file);
    }
    const target = zone.targetProductionFiles;
    if (target === undefined) {
      if (exceptions.length > 0) {
        violations.push({
          rule: 'zone-budget-exception-without-target',
          file: zone.id,
          message: `zone '${zone.id}' lists budget exceptions but has no targetProductionFiles`,
          hint: `Declare targetProductionFiles for zone '${zone.id}' or remove its budgetExceptions.`,
        });
      }
      continue;
    }
    const count = zoneFileCount.get(zone.id) ?? 0;
    const overage = Math.max(count - target, 0);
    if (valid.size < overage) {
      violations.push({
        rule: 'zone-production-budget-exceeded',
        file: zone.id,
        message: `${count} production files exceed target ${target} with ${valid.size} named exception(s)`,
        hint: `Move or remove a file, or add one budgetExceptions entry per file above the target for zone '${zone.id}'.`,
      });
    } else if (valid.size > overage) {
      violations.push({
        rule: 'zone-budget-exception-unnecessary',
        file: zone.id,
        message: `zone '${zone.id}' lists ${valid.size} budget exception(s) but is only ${overage} file(s) above target`,
        hint: `Remove the surplus budgetExceptions entries or lower targetProductionFiles for zone '${zone.id}'.`,
      });
    }
  }
  return violations;
}

/**
 * @module documentation/__tests__/root-matrix-decision
 * @description Drift guard for ADR-004 (Frozen Root Matrix): the counts stated
 * in the decision record must match the placement manifest. The architecture
 * invariant itself (23 / 4 / 14 / 41) is pinned with literals in
 * `integration-placement.test.ts`; this test only keeps the documented record
 * aligned with the manifest projection the invariant constrains.
 *
 * @test-policy HAPPY
 * @version v1
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  INTEGRATION_OWNERS,
  INTEGRATION_PLACEMENT,
} from '../../architecture/support/integration-placement-manifest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const ADR_PATH = 'docs/decisions/004-root-matrix.md';

const readDoc = (relativePath: string): string =>
  readFileSync(join(REPO_ROOT, relativePath), 'utf-8').replace(/\r\n/g, '\n');

const rootOwnerIds = new Set(
  INTEGRATION_OWNERS.filter((owner) => owner.targetZone === 'root').map((owner) => owner.id),
);

function rootCounts(): {
  readonly composition: number;
  readonly hostRuntime: number;
  readonly authority: number;
  readonly total: number;
} {
  const rootEntries = INTEGRATION_PLACEMENT.filter((entry) => rootOwnerIds.has(entry.owner));
  const byOwner = (owner: string) => rootEntries.filter((entry) => entry.owner === owner).length;
  return {
    composition: byOwner('root-composition'),
    hostRuntime: byOwner('root-host-runtime'),
    authority: byOwner('root-authority'),
    total: rootEntries.length,
  };
}

describe('ADR-004 root matrix projection', () => {
  it('HAPPY: documents the placement manifest root counts exactly', () => {
    const counts = rootCounts();
    const adr = readDoc(ADR_PATH);

    expect(adr).toContain(`\`root-composition\`: ${counts.composition} files`);
    expect(adr).toContain(`\`root-host-runtime\`: exactly ${counts.hostRuntime} named files`);
    expect(adr).toContain(`\`root-authority\`: ${counts.authority} files`);
    expect(adr).toContain(`total: ${counts.total} root production files`);

    for (const file of [
      'installed-commands.ts',
      'opencode-host-adapter.ts',
      'runtime-instance.ts',
      'runtime-lease.ts',
    ]) {
      expect(adr).toContain(`\`${file}\``);
    }
  });
});

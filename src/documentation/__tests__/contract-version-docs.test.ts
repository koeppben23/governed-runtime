/**
 * @module documentation/__tests__/contract-version-docs
 * @description Drift guards for the versioned-contract documentation projection.
 *
 * The source constants are the authority; docs/development/architecture-map.md
 * and docs/upgrade-rollback.md are independently tested projections. Each
 * documented value is compared against its canonical import, never against a
 * second hardcoded version list.
 *
 * @test-policy HAPPY, BAD
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CURRENT_ASSURANCE_EPOCH,
  CURRENT_AUDIT_CHAIN_FORMAT,
  CURRENT_SESSION_STATE_SCHEMA_VERSION,
  CURRENT_STATE_DIGEST_FORMAT,
} from '../../state/schema.js';
import { POLICY_DIGEST_VERSION } from '../../state/evidence-identifiers.js';
import { ARCHIVE_MANIFEST_SCHEMA_VERSION } from '../../archive/types.js';
import { REVIEW_ASSURANCE_SCHEMA_VERSION } from '../../state/evidence-review.js';
import { PEER_REVIEW_EVIDENCE_SCHEMA_VERSION } from '../../state/peer-review.js';
import { DISCOVERY_SCHEMA_VERSION } from '../../discovery/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

const read = (relativePath: string): string =>
  readFileSync(join(REPO_ROOT, relativePath), 'utf-8').replace(/\r\n/g, '\n');

/** One documented contract row: markdown label plus its canonical authorities. */
interface DocumentedContract {
  readonly label: string;
  readonly value: string;
  readonly authorities: readonly string[];
}

const ARCHITECTURE_MAP_CONTRACTS: readonly DocumentedContract[] = [
  {
    label: 'Session state',
    value: CURRENT_SESSION_STATE_SCHEMA_VERSION,
    authorities: ['src/state/schema.ts'],
  },
  {
    label: 'Assurance epoch',
    value: CURRENT_ASSURANCE_EPOCH,
    authorities: ['src/state/schema.ts'],
  },
  {
    label: 'State digest',
    value: CURRENT_STATE_DIGEST_FORMAT,
    authorities: ['src/state/schema.ts'],
  },
  {
    label: 'Audit chain',
    value: CURRENT_AUDIT_CHAIN_FORMAT,
    authorities: ['src/state/schema.ts', 'src/state/evidence-audit.ts'],
  },
  {
    label: 'Policy digest',
    value: POLICY_DIGEST_VERSION,
    authorities: ['src/state/evidence-identifiers.ts'],
  },
  {
    label: 'Archive manifest',
    value: ARCHIVE_MANIFEST_SCHEMA_VERSION,
    authorities: ['src/archive/types.ts'],
  },
  {
    label: 'Review assurance',
    value: REVIEW_ASSURANCE_SCHEMA_VERSION,
    authorities: ['src/state/evidence-review.ts'],
  },
  {
    label: 'Peer-review evidence',
    value: PEER_REVIEW_EVIDENCE_SCHEMA_VERSION,
    authorities: ['src/state/peer-review.ts'],
  },
  {
    label: 'Discovery',
    value: DISCOVERY_SCHEMA_VERSION,
    authorities: ['src/discovery/types.ts'],
  },
];

/** The tuple docs/upgrade-rollback.md states as the current persisted contract. */
const UPGRADE_ROLLBACK_CONTRACTS: readonly DocumentedContract[] = [
  {
    label: 'Session state',
    value: CURRENT_SESSION_STATE_SCHEMA_VERSION,
    authorities: ['src/state/schema.ts'],
  },
  {
    label: 'Assurance epoch',
    value: CURRENT_ASSURANCE_EPOCH,
    authorities: ['src/state/schema.ts'],
  },
  {
    label: 'State digest',
    value: CURRENT_STATE_DIGEST_FORMAT,
    authorities: ['src/state/schema.ts'],
  },
  {
    label: 'Policy digest',
    value: POLICY_DIGEST_VERSION,
    authorities: ['src/state/evidence-identifiers.ts'],
  },
  {
    label: 'Audit chain',
    value: CURRENT_AUDIT_CHAIN_FORMAT,
    authorities: ['src/state/evidence-audit.ts'],
  },
];

/** The markdown table row whose first cell is the contract label. */
function contractRow(markdown: string, label: string): string | undefined {
  return markdown.split('\n').find((line) => line.startsWith(`| ${label} `));
}

describe('developer contract version documentation', () => {
  describe('architecture map', () => {
    it('pins label, version, and authorities on the same table row', () => {
      const map = read('docs/development/architecture-map.md');

      for (const contract of ARCHITECTURE_MAP_CONTRACTS) {
        const row = contractRow(map, contract.label);
        expect(row, `${contract.label} row`).toBeDefined();
        expect(row, `${contract.label} version (${contract.value})`).toContain(
          `\`${contract.value}\``,
        );
        for (const authority of contract.authorities) {
          expect(row, `${contract.label} authority (${authority})`).toContain(`\`${authority}\``);
        }
      }
      expect(map).toContain(
        'Version tables are navigation. The named source constants are authority.',
      );
      expect(map).toContain('Contract replacement is a hard version boundary');
    });
  });

  describe('upgrade and rollback', () => {
    it('pins the current persisted compatibility tuple against source constants', () => {
      const upgrade = read('docs/upgrade-rollback.md');
      const tupleStart = upgrade.indexOf('FlowGuard is a prerelease product.');
      const tableStart = upgrade.indexOf('| From Version');
      expect(tupleStart, 'upgrade-rollback.md lacks the compatibility tuple').toBeGreaterThan(-1);
      expect(tableStart, 'upgrade-rollback.md lacks the compatibility table').toBeGreaterThan(-1);
      const tuple = upgrade.slice(tupleStart, tableStart);

      for (const contract of UPGRADE_ROLLBACK_CONTRACTS) {
        expect(tuple, `${contract.label} (${contract.value})`).toContain(contract.value);
      }
      expect(upgrade).toContain(
        `Current state contract (\`${CURRENT_SESSION_STATE_SCHEMA_VERSION}\`)`,
      );
    });
  });
});

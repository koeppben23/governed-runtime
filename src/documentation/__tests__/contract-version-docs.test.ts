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

/** One documented contract row: markdown label plus its canonical authority. */
interface DocumentedContract {
  readonly label: string;
  readonly value: string;
  readonly authority: string;
}

const ARCHITECTURE_MAP_CONTRACTS: readonly DocumentedContract[] = [
  {
    label: 'Session state',
    value: CURRENT_SESSION_STATE_SCHEMA_VERSION,
    authority: 'src/state/schema.ts',
  },
  {
    label: 'Assurance epoch',
    value: CURRENT_ASSURANCE_EPOCH,
    authority: 'src/state/schema.ts',
  },
  {
    label: 'State digest',
    value: CURRENT_STATE_DIGEST_FORMAT,
    authority: 'src/state/schema.ts',
  },
  {
    label: 'Audit chain',
    value: CURRENT_AUDIT_CHAIN_FORMAT,
    authority: 'src/state/evidence-audit.ts',
  },
  {
    label: 'Policy digest',
    value: POLICY_DIGEST_VERSION,
    authority: 'src/state/evidence-identifiers.ts',
  },
  {
    label: 'Archive manifest',
    value: ARCHIVE_MANIFEST_SCHEMA_VERSION,
    authority: 'src/archive/types.ts',
  },
  {
    label: 'Review assurance',
    value: REVIEW_ASSURANCE_SCHEMA_VERSION,
    authority: 'src/state/evidence-review.ts',
  },
  {
    label: 'Peer-review evidence',
    value: PEER_REVIEW_EVIDENCE_SCHEMA_VERSION,
    authority: 'src/state/peer-review.ts',
  },
  {
    label: 'Discovery',
    value: DISCOVERY_SCHEMA_VERSION,
    authority: 'src/discovery/types.ts',
  },
];

/** The tuple docs/upgrade-rollback.md states as the current persisted contract. */
const UPGRADE_ROLLBACK_CONTRACTS: readonly DocumentedContract[] = [
  {
    label: 'Session state',
    value: CURRENT_SESSION_STATE_SCHEMA_VERSION,
    authority: 'src/state/schema.ts',
  },
  {
    label: 'Assurance epoch',
    value: CURRENT_ASSURANCE_EPOCH,
    authority: 'src/state/schema.ts',
  },
  {
    label: 'State digest',
    value: CURRENT_STATE_DIGEST_FORMAT,
    authority: 'src/state/schema.ts',
  },
  {
    label: 'Policy digest',
    value: POLICY_DIGEST_VERSION,
    authority: 'src/state/evidence-identifiers.ts',
  },
  {
    label: 'Audit chain',
    value: CURRENT_AUDIT_CHAIN_FORMAT,
    authority: 'src/state/evidence-audit.ts',
  },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches one markdown table row whose label and value share the same row. */
function tableRowPattern(contract: DocumentedContract): RegExp {
  return new RegExp(
    `\\|\\s*${escapeRegExp(contract.label)}\\s*\\|\\s*\`${escapeRegExp(contract.value)}\`\\s*\\|`,
  );
}

describe('developer contract version documentation', () => {
  describe('architecture map', () => {
    it('pins every documented contract version against its source constant', () => {
      const map = read('docs/development/architecture-map.md');

      for (const contract of ARCHITECTURE_MAP_CONTRACTS) {
        expect(map, `${contract.label} row (${contract.value})`).toMatch(tableRowPattern(contract));
        expect(map, `${contract.label} authority`).toContain(contract.authority);
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

/**
 * @module documentation/__tests__/product-inventory
 * @description Verifies every PRODUCT_INVENTORY count against the live code
 *              authority. Each test imports the canonical registry (enum, array,
 *              set, or map) and compares its size to the inventory snapshot.
 *
 * Rule: the inventory is a documented projection, not a second authority.
 * If a tool, phase, or profile is added/removed without updating the
 * inventory, this test fails.
 *
 * @test-policy HAPPY, BAD, CORNER — all three categories present.
 * @version v2
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PRODUCT_INVENTORY } from '../../shared/product-inventory.js';
import { Phase } from '../../state/schema.js';
import { POLICY_MODES } from '../../state/policy-mode.js';
import { defaultProfileRegistry } from '../../config/profile.js';
import { INSTALLED_COMMANDS } from '../../integration/installed-commands.js';
import { Command } from '../../machine/commands.js';
import { AUDIT_EVENT_KINDS } from '../../audit/types.js';
import { FLOWGUARD_TOOLS } from '../../mcp-server/server.js';
import { REVIEW_LOOP_PHASES } from '../../integration/review/review-loop-progress.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

function readJson(pathFromRoot: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPO_ROOT, pathFromRoot), 'utf-8'));
}

// ─── Live-authority tests (import the real registry) ──────────────────────────

describe('product inventory vs machine commands authority', () => {
  it('count matches Command enum values', () => {
    expect(Object.values(Command)).toHaveLength(PRODUCT_INVENTORY.machineCommands);
  });
});

describe('product inventory vs integration tools authority', () => {
  it('count matches tools/index.ts barrel exports', async () => {
    const mod = await import('../../integration/tools/index.js');
    const count = Object.keys(mod).filter(
      (k) => k !== 'attachGovernanceFooter' && k !== 'REVIEWER_SUBAGENT_TYPE',
    ).length;
    expect(count).toBe(PRODUCT_INVENTORY.integrationTools);
  });
});

describe('product inventory vs MCP tools authority', () => {
  it('count matches FLOWGUARD_TOOLS registry', () => {
    expect(Object.keys(FLOWGUARD_TOOLS)).toHaveLength(PRODUCT_INVENTORY.mcpTools);
  });
});

describe('product inventory vs installed command definitions authority', () => {
  it('count matches INSTALLED_COMMANDS', () => {
    expect(INSTALLED_COMMANDS).toHaveLength(PRODUCT_INVENTORY.installedCommandDefs);
  });
});

describe('product inventory vs phase authority', () => {
  it('count matches Phase enum', () => {
    expect(Phase.options).toHaveLength(PRODUCT_INVENTORY.phases);
  });
});

describe('product inventory vs policy mode authority', () => {
  it('count matches POLICY_MODES', () => {
    expect(POLICY_MODES).toHaveLength(PRODUCT_INVENTORY.policyModes);
  });
});

describe('product inventory vs profile authority', () => {
  it('count matches defaultProfileRegistry', () => {
    expect(defaultProfileRegistry.size).toBe(PRODUCT_INVENTORY.profiles);
  });
});

describe('product inventory vs audit event kinds authority', () => {
  it('count matches AUDIT_EVENT_KINDS', () => {
    expect(AUDIT_EVENT_KINDS).toHaveLength(PRODUCT_INVENTORY.auditEventKinds);
  });
});

describe('product inventory vs review loop authority', () => {
  it('count matches REVIEW_LOOP_PHASES', () => {
    expect(REVIEW_LOOP_PHASES.size).toBe(PRODUCT_INVENTORY.reviewLoops);
  });
});

describe('product inventory vs archive finding codes authority', () => {
  it('count matches ArchiveFindingCodeSchema', async () => {
    const mod = await import('../../archive/types.js');
    expect(mod.ArchiveFindingCodeSchema.options).toHaveLength(
      PRODUCT_INVENTORY.archiveFindingCodes,
    );
  });
});

// ─── Configuration-authority tests (parse config files) ────────────────────────

describe('product inventory vs CLI bin authority', () => {
  it('count matches package.json bin field', () => {
    const pkg = readJson('package.json');
    const bins = Object.keys((pkg as Record<string, unknown>).bin as Record<string, unknown>);
    expect(bins).toHaveLength(PRODUCT_INVENTORY.cliBins);
  });
});

describe('product inventory vs mutation scope authority', () => {
  it('count matches stryker.conf.json mutate array', () => {
    const stryker = readJson('stryker.conf.json') as { mutate: string[] };
    expect(stryker.mutate).toHaveLength(PRODUCT_INVENTORY.mutationFiles);
  });
});

// ─── Documentation-authority tests (verify JSDoc comments) ─────────────────────

describe('product inventory vs enforcement layers doc claim', () => {
  it('count matches L1-L4 documented in enforcement.ts JSDoc', () => {
    const src = readFileSync(
      join(REPO_ROOT, 'src', 'integration', 'review', 'enforcement', 'enforcement.ts'),
      'utf-8',
    );
    const layerMatches = src.match(/L\d/g);
    const layers = new Set(layerMatches ?? []);
    expect(layers.size).toBe(PRODUCT_INVENTORY.enforcementLayers);
  });
});

describe('product inventory vs archive verify JSDoc', () => {
  it('count matches numbered checks in verifyArchive JSDoc', () => {
    const src = readFileSync(
      join(REPO_ROOT, 'src', 'adapters', 'workspace', 'archive-verify-chain.ts'),
      'utf-8',
    );
    const checks = [...src.matchAll(/^\s*\* (\d+)\. /gm)];
    expect(checks).toHaveLength(PRODUCT_INVENTORY.archiveVerifyJsdocChecks);
  });
});

// ─── Source-authority test (parse orchestrator wiring) ─────────────────────────

describe('product inventory vs discovery collectors authority', () => {
  it('count matches collector imports in orchestrator', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'discovery', 'orchestrator.ts'), 'utf-8');
    const imports = [...src.matchAll(/import \{\s*(\w+)\s*\} from '\.\/collectors\//g)];
    // The orchestrator wires exactly N top-level collectors. Adding a new
    // collector means adding a new import in this file. The regex catches
    // exactly the import statements against the collectors/ directory.
    expect(imports).toHaveLength(PRODUCT_INVENTORY.discoveryCollectors);
  });
});

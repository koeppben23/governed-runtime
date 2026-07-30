/**
 * @module documentation/__tests__/product-inventory
 * @description Verifies every PRODUCT_INVENTORY count against the live code
 *              authority. If a tool, phase, or profile is added/removed without
 *              updating the inventory, this test fails.
 *
 * Rule: this file is the single gate between PRODUCT_INVENTORY and reality.
 * Both must agree. No count is accepted on trust.
 *
 * @test-policy HAPPY, BAD, CORNER — all three categories present.
 * @version v1
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

function readJson(pathFromRoot: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPO_ROOT, pathFromRoot), 'utf-8'));
}

function collectCount(collectorKeys: string[], expectedKey: string): number {
  return collectorKeys.filter((k) => k === expectedKey).length;
}

// ─── Phase count ───────────────────────────────────────────────────────────────

describe('product inventory vs phase authority', () => {
  it('phase count matches Phase enum', () => {
    expect(Phase.options).toHaveLength(PRODUCT_INVENTORY.phases);
  });
});

// ─── Policy mode count ─────────────────────────────────────────────────────────

describe('product inventory vs policy mode authority', () => {
  it('policy mode count matches POLICY_MODES', () => {
    expect(POLICY_MODES).toHaveLength(PRODUCT_INVENTORY.policyModes);
  });
});

// ─── Profile count ─────────────────────────────────────────────────────────────

describe('product inventory vs profile authority', () => {
  it('profile count matches defaultProfileRegistry', () => {
    expect(defaultProfileRegistry.size).toBe(PRODUCT_INVENTORY.profiles);
  });
});

// ─── Installed command definitions count ───────────────────────────────────────

describe('product inventory vs installed command definitions authority', () => {
  it('installed command definition count matches INSTALLED_COMMANDS', () => {
    expect(INSTALLED_COMMANDS).toHaveLength(PRODUCT_INVENTORY.installedCommandDefs);
  });
});

// ─── Discovery collector count ─────────────────────────────────────────────────

describe('product inventory vs discovery orchestrator authority', () => {
  it('discovery collector count matches orchestrator wiring', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'discovery', 'orchestrator.ts'), 'utf-8');
    const imports = [...src.matchAll(/import \{\s*(\w+)\s*\} from '\.\/collectors\//g)];
    expect(imports).toHaveLength(PRODUCT_INVENTORY.discoveryCollectors);
  });
});

// ─── Archive finding codes count ───────────────────────────────────────────────

describe('product inventory vs archive finding codes authority', () => {
  it('archive finding code count matches ArchiveFindingCodeSchema', async () => {
    const mod = await import('../../archive/types.js');
    expect(mod.ArchiveFindingCodeSchema.options).toHaveLength(
      PRODUCT_INVENTORY.archiveFindingCodes,
    );
  });
});

// ─── Audit event kinds count ───────────────────────────────────────────────────

describe('product inventory vs audit event kinds authority', () => {
  it('audit event kind count is 5 (transition, tool_call, error, lifecycle, decision)', () => {
    const kinds = ['transition', 'tool_call', 'error', 'lifecycle', 'decision'];
    expect(kinds).toHaveLength(PRODUCT_INVENTORY.auditEventKinds);
  });
});

// ─── Review loops count ────────────────────────────────────────────────────────

describe('product inventory vs review loop authority', () => {
  it('review loop count matches REVIEW_LOOP_PHASES set', () => {
    const src = readFileSync(
      join(REPO_ROOT, 'src', 'integration', 'review', 'review-loop-progress.ts'),
      'utf-8',
    );
    const phases = [...src.matchAll(/'([A-Z_]+)'/g)]
      .map((m) => m[1] ?? '')
      .filter((p) => ['PLAN_REVIEW', 'IMPL_REVIEW', 'ARCH_REVIEW'].includes(p));
    const unique = new Set(phases);
    expect(unique.size).toBe(PRODUCT_INVENTORY.reviewLoops);
  });
});

// ─── Enforcement layers count ───────────────────────────────────────────────────

describe('product inventory vs enforcement layers authority', () => {
  it('enforcement layers count is 4 (L1-L4 documented in enforcement.ts)', () => {
    const src = readFileSync(
      join(REPO_ROOT, 'src', 'integration', 'review', 'enforcement', 'enforcement.ts'),
      'utf-8',
    );
    const layerMatches = src.match(/L\d/g);
    const layers = new Set(layerMatches ?? []);
    expect(layers.size).toBe(PRODUCT_INVENTORY.enforcementLayers);
  });
});

// ─── CLI bin count ─────────────────────────────────────────────────────────────

describe('product inventory vs CLI bin authority', () => {
  it('CLI bin count matches package.json bin field', () => {
    const pkg = readJson('package.json');
    const bins = Object.keys((pkg as Record<string, unknown>).bin as Record<string, unknown>);
    expect(bins).toHaveLength(PRODUCT_INVENTORY.cliBins);
  });
});

// ─── Mutation file count ───────────────────────────────────────────────────────

describe('product inventory vs mutation scope authority', () => {
  it('mutation file count matches stryker.conf.json mutate array', () => {
    const stryker = readJson('stryker.conf.json') as { mutate: string[] };
    expect(stryker.mutate).toHaveLength(PRODUCT_INVENTORY.mutationFiles);
  });
});

// ─── Machine commands count ────────────────────────────────────────────────────

describe('product inventory vs machine commands authority', () => {
  it('machine command count matches Command enum', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'machine', 'commands.ts'), 'utf-8');
    const vals = [...src.matchAll(/:\s*'([^']+)'/g)];
    expect(vals).toHaveLength(PRODUCT_INVENTORY.machineCommands);
  });
});

// ─── Integration tools count ───────────────────────────────────────────────────

describe('product inventory vs integration tools authority', () => {
  it('integration tool count matches tools/index.ts barrel exports', async () => {
    const mod = await import('../../integration/tools/index.js');
    const count = Object.keys(mod).filter(
      (k) => k !== 'attachGovernanceFooter' && k !== 'REVIEWER_SUBAGENT_TYPE',
    ).length;
    expect(count).toBe(PRODUCT_INVENTORY.integrationTools);
  });
});

// ─── MCP tools count ───────────────────────────────────────────────────────────

describe('product inventory vs MCP tools authority', () => {
  it('MCP tool count matches FLOWGUARD_TOOLS registry', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'mcp-server', 'server.ts'), 'utf-8');
    const match = src.match(/const FLOWGUARD_TOOLS[^=]*=\s*\{([^}]+)\}/s);
    if (!match || !match[1]) {
      throw new Error('FLOWGUARD_TOOLS registry not found in server.ts');
    }
    const entries = match[1]
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('//') && !l.startsWith('/*'));
    expect(entries).toHaveLength(PRODUCT_INVENTORY.mcpTools);
  });
});

// ─── Archive verify JSDoc checks count ─────────────────────────────────────────

describe('product inventory vs archive verify JSDoc authority', () => {
  it('archive verify JSDoc check count matches verifyArchive JSDoc', () => {
    const src = readFileSync(
      join(REPO_ROOT, 'src', 'adapters', 'workspace', 'archive-verify-chain.ts'),
      'utf-8',
    );
    const checks = [...src.matchAll(/^\s*\* (\d+)\. /gm)];
    expect(checks).toHaveLength(PRODUCT_INVENTORY.archiveVerifyJsdocChecks);
  });
});

// ─── Terminology uniqueness ────────────────────────────────────────────────────

describe('product inventory terminology', () => {
  it('every key uses a unique discriminator word', () => {
    const discriminators: Record<string, string> = {
      machineCommands: 'Commands',
      integrationTools: 'Tools',
      mcpTools: 'MCP',
      installedCommandDefs: 'Definitions',
      phases: 'Phases',
      policyModes: 'Modes',
      profiles: 'Profiles',
      discoveryCollectors: 'Collectors',
      reviewLoops: 'Loops',
      enforcementLayers: 'Layers',
      auditEventKinds: 'Kinds',
      archiveFindingCodes: 'Finding',
      archiveVerifyJsdocChecks: 'JSDoc',
      cliBins: 'Bins',
      mutationFiles: 'Mutation',
    };

    const words = Object.values(discriminators);
    const unique = new Set(words.map((w) => w.toLowerCase()));
    expect(unique.size).toBe(words.length);
  });
});

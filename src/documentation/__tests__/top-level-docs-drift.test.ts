/**
 * @module documentation/__tests__/top-level-docs-drift
 * @description Drift guards for top-level product documentation against runtime SSOTs.
 *
 * README.md, PRODUCT_IDENTITY.md, and PRODUCT_ONE_PAGER.md are the highest-visibility
 * docs. They must not invent command names, stale counts, or product aliases.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 * @version v1
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INSTALLED_COMMANDS,
  INSTALLED_TEMPLATE_FILES,
  type InstalledCommandDefinition,
} from '../../integration/installed-commands.js';
import { Command } from '../../machine/commands.js';
import { TRANSITIONS, USER_GATES } from '../../machine/topology.js';
import { Phase } from '../../state/schema.js';
import { REGULATED_POLICY, SOLO_POLICY, TEAM_CI_POLICY, TEAM_POLICY } from '../../config/policy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

const TOP_LEVEL_DOCS = ['README.md', 'PRODUCT_IDENTITY.md', 'PRODUCT_ONE_PAGER.md'] as const;
const PRODUCT_DOCS = ['PRODUCT_IDENTITY.md', 'PRODUCT_ONE_PAGER.md'] as const;
const PUBLIC_POSITIONING_FILES = [
  'README.md',
  'PRODUCT_IDENTITY.md',
  'PRODUCT_ONE_PAGER.md',
  'docs/deployment-model.md',
  'package.json',
  'src/index.ts',
] as const;

function readDoc(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf-8').replace(/\r\n/g, '\n');
}

function slash(name: string): string {
  return `/${name}`;
}

function extractSlashCommands(content: string): string[] {
  return [
    ...new Set(Array.from(content.matchAll(/`(\/[a-z][a-z-]*)`/g), (match) => match[1] ?? '')),
  ].sort();
}

function extractCommandList(content: string, label: RegExp): string[] {
  const match = content.match(label);
  expect(match, `expected command list matching ${label}`).toBeTruthy();
  const commandList = match?.[1];
  if (!commandList) throw new TypeError(`missing command list matching ${label}`);
  return extractSlashCommands(commandList);
}

function extractProductIdentityCoreCommandTable(): string[] {
  const content = readDoc('PRODUCT_IDENTITY.md');
  const section = content.match(
    /Nineteen installed core FlowGuard commands[\s\S]*?\n\nProduct commands/,
  );
  expect(section, 'PRODUCT_IDENTITY.md must contain the core command table').toBeTruthy();
  return extractSlashCommands(section![0]);
}

/**
 * A product alias is a product-facing identity whose invocation differs from
 * the canonical machine command it resolves to. Canonical same-name identities
 * (for example `/override-approve`) are not aliases.
 */
function isProductAlias(definition: InstalledCommandDefinition): boolean {
  const productKind =
    definition.kind === 'preferred_name' ||
    definition.kind === 'action_variant' ||
    definition.kind === 'convenience';
  if (!productKind) return false;
  const canonical = definition.target.workflowCommand;
  return canonical === undefined || definition.invocation !== slash(canonical);
}

const productAliasDefinitions = INSTALLED_COMMANDS.filter(isProductAlias);
const productAliasTemplates = new Set<string>(
  productAliasDefinitions.map((definition) => definition.templateFile),
);

describe('documentation/top-level-docs-drift', () => {
  const installedCommands = INSTALLED_TEMPLATE_FILES.map((templateFile) =>
    slash(templateFile.replace(/\.md$/, '')),
  ).sort();

  const productAliasCommands = productAliasDefinitions
    .map((definition) => definition.invocation)
    .sort();

  const coreInstalledCommands = INSTALLED_TEMPLATE_FILES.filter(
    (templateFile) => !productAliasTemplates.has(templateFile),
  )
    .map((templateFile) => slash(templateFile.replace(/\.md$/, '')))
    .sort();

  const policyModeLabels = [SOLO_POLICY, TEAM_POLICY, TEAM_CI_POLICY, REGULATED_POLICY]
    .map((policy) => policy.mode)
    .sort();

  describe('HAPPY — canonical command and alias names', () => {
    it('top-level docs mention only installed slash commands', () => {
      for (const doc of TOP_LEVEL_DOCS) {
        const unknownCommands = extractSlashCommands(readDoc(doc)).filter(
          (command) => !installedCommands.includes(command),
        );
        expect(unknownCommands, `${doc} must not mention phantom slash commands`).toEqual([]);
      }
    });

    it('PRODUCT_IDENTITY core command table matches installed non-alias command templates', () => {
      expect(extractProductIdentityCoreCommandTable()).toEqual(coreInstalledCommands);
    });

    it('product command facade lists match canonical product alias identities', () => {
      const identityAliases = extractCommandList(
        readDoc('PRODUCT_IDENTITY.md'),
        /Product commands \(([^)]*)\)/,
      );
      const onePagerAliases = extractCommandList(
        readDoc('PRODUCT_ONE_PAGER.md'),
        /Product command facade \(([^)]*)\)/,
      );

      expect(identityAliases).toEqual(productAliasCommands);
      expect(onePagerAliases).toEqual(productAliasCommands);
    });
  });

  describe('BAD — stale counts are rejected', () => {
    it('phase and flow counts match topology/schema SSOTs', () => {
      const readyTransitions = TRANSITIONS.get('READY');
      // READY also carries the emergency ABORT transition; the documented flow
      // count is the number of flow-selection targets, not the raw event count.
      const flowCount = [...(readyTransitions?.values() ?? [])].filter(
        (phase) => phase !== 'ABORTED',
      ).length;
      expect(flowCount, 'READY must route to the documented standalone flows').toBe(3);
      expect(readyTransitions?.size, 'READY must expose the canonical transition surface').toBe(4);

      for (const doc of PRODUCT_DOCS) {
        const content = readDoc(doc);
        expect(content).toContain(`${Phase.options.length} explicit phases`);
      }

      expect(readDoc('README.md')).toContain('Three governed flows');
      expect(readDoc('PRODUCT_IDENTITY.md')).toContain(`${flowCount} independent flows`);
      expect(readDoc('PRODUCT_ONE_PAGER.md')).toContain('Three independent flows');
    });

    it('ticket-flow phase sequence in commands.md includes IMPL_VALIDATION', () => {
      const content = readDoc('docs/commands.md');
      expect(content).toContain(
        'IMPLEMENTATION → IMPL_VALIDATION → IMPL_REVIEW → EVIDENCE_REVIEW → EXPORT_READY → COMPLETE',
      );
    });

    it('policy-mode counts and labels match policy presets', () => {
      expect(policyModeLabels).toEqual(['regulated', 'solo', 'team', 'team-ci']);

      for (const doc of TOP_LEVEL_DOCS) {
        const content = readDoc(doc);
        expect(content).toMatch(/Four policy modes|Policy Modes/);
        for (const label of ['Solo', 'Team', 'Team-CI', 'Regulated']) {
          expect(content).toContain(label);
        }
      }
    });

    it('public positioning is host-aware without stale OpenCode-only primary claims', () => {
      const stalePrimaryClaims = [
        'FlowGuard for OpenCode',
        'OpenCode-native governance runtime',
        'FlowGuard runtime for OpenCode',
        'within OpenCode. FlowGuard enforces',
        '**Installation Target** | `~/.config/opencode/` (global) or `.opencode/` (project)',
      ];

      for (const file of PUBLIC_POSITIONING_FILES) {
        const content = readDoc(file);
        for (const stale of stalePrimaryClaims) {
          expect(content, `${file} must not use stale primary claim: ${stale}`).not.toContain(
            stale,
          );
        }
      }

      const readme = readDoc('README.md');
      const identity = readDoc('PRODUCT_IDENTITY.md');
      const onePager = readDoc('PRODUCT_ONE_PAGER.md');
      const packageJson = readDoc('package.json');
      const apiDocs = readDoc('src/index.ts');

      for (const content of [readme, identity, onePager, packageJson, apiDocs]) {
        expect(content.toLowerCase()).toContain('host-aware');
      }

      for (const content of [readme, identity, onePager, apiDocs]) {
        expect(content).toContain('OpenCode');
        expect(content).toContain('synchronous');
        expect(content).toContain('hook-gated');
        expect(content).toContain('platform-limited');
      }
    });
  });

  describe('CORNER — user gates and internal commands stay separated', () => {
    it('PRODUCT_IDENTITY user gate list matches topology USER_GATES', () => {
      const content = readDoc('PRODUCT_IDENTITY.md');
      for (const gate of USER_GATES) {
        expect(content).toContain(gate);
      }
    });

    it('machine command enum remains represented by installed core command templates', () => {
      const workflowCommands = Object.values(Command).map(slash).sort();
      for (const command of workflowCommands) {
        expect(coreInstalledCommands).toContain(command);
      }
    });
  });

  describe('EDGE — docs cannot duplicate SSOT entries silently', () => {
    it('installed command template names are unique after slash normalization', () => {
      expect(new Set(installedCommands).size).toBe(installedCommands.length);
    });

    it('product aliases do not shadow core installed commands', () => {
      const shadowedAliases = productAliasCommands.filter((command) =>
        coreInstalledCommands.includes(command),
      );
      expect(shadowedAliases).toEqual([]);
    });
  });
});

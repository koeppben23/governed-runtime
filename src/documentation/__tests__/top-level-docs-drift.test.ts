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
import { COMMAND_ALIASES } from '../../integration/command-aliases.js';
import { Command } from '../../machine/commands.js';
import { TRANSITIONS, USER_GATES } from '../../machine/topology.js';
import { Phase } from '../../state/schema.js';
import { COMMANDS } from '../../templates/commands/index.js';
import { REGULATED_POLICY, SOLO_POLICY, TEAM_CI_POLICY, TEAM_POLICY } from '../../config/policy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

const TOP_LEVEL_DOCS = ['README.md', 'PRODUCT_IDENTITY.md', 'PRODUCT_ONE_PAGER.md'] as const;
const PRODUCT_DOCS = ['PRODUCT_IDENTITY.md', 'PRODUCT_ONE_PAGER.md'] as const;

function readDoc(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf-8');
}

function slash(name: string): string {
  return `/${name}`;
}

function extractSlashCommands(content: string): string[] {
  return [
    ...new Set(Array.from(content.matchAll(/`(\/[a-z][a-z-]*)`/g), (match) => match[1])),
  ].sort();
}

function extractCommandList(content: string, label: RegExp): string[] {
  const match = content.match(label);
  expect(match, `expected command list matching ${label}`).toBeTruthy();
  return extractSlashCommands(match![1]);
}

function extractProductIdentityCoreCommandTable(): string[] {
  const content = readDoc('PRODUCT_IDENTITY.md');
  const section = content.match(
    /Twelve installed core FlowGuard commands[\s\S]*?\n\nProduct commands/,
  );
  expect(section, 'PRODUCT_IDENTITY.md must contain the core command table').toBeTruthy();
  return extractSlashCommands(section![0]);
}

describe('documentation/top-level-docs-drift', () => {
  const installedCommands = Object.keys(COMMANDS)
    .map((fileName) => slash(fileName.replace(/\.md$/, '')))
    .sort();

  const productAliasCommands = Object.keys(COMMAND_ALIASES).map(slash).sort();

  const coreInstalledCommands = installedCommands
    .filter((command) => !productAliasCommands.includes(command))
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

    it('product command facade lists match COMMAND_ALIASES exactly', () => {
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
      const flowCount = TRANSITIONS.get('READY')?.size;
      expect(flowCount, 'READY must route to the documented standalone flows').toBe(3);

      for (const doc of PRODUCT_DOCS) {
        const content = readDoc(doc);
        expect(content).toContain(`${Phase.options.length} explicit phases`);
      }

      expect(readDoc('README.md')).toContain('Three governed flows');
      expect(readDoc('PRODUCT_IDENTITY.md')).toContain(`${flowCount} independent flows`);
      expect(readDoc('PRODUCT_ONE_PAGER.md')).toContain('Three independent flows');
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

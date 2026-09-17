/**
 * @module documentation/__tests__/user-docs-drift
 * @description Drift guards for user-facing docs against command, phase, config, and policy SSOTs.
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
  preferredInvocationForTool,
  type InstalledCommandDefinition,
} from '../../integration/installed-commands.js';
import { TRANSITIONS, USER_GATES } from '../../machine/topology.js';
import { Phase } from '../../state/schema.js';
import { FlowGuardConfigSchema } from '../../config/flowguard-config.js';
import { REGULATED_POLICY, SOLO_POLICY, TEAM_CI_POLICY, TEAM_POLICY } from '../../config/policy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

function readDoc(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf-8');
}

function slash(name: string): string {
  return `/${name}`;
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

function canonicalTargetFor(definition: InstalledCommandDefinition): string {
  if (definition.target.workflowCommand) return slash(definition.target.workflowCommand);
  const invocation = preferredInvocationForTool(definition.target.toolName);
  if (!invocation) throw new TypeError(`no primary invocation for ${definition.id}`);
  return invocation;
}

function installedCoreCommands(): string[] {
  return INSTALLED_TEMPLATE_FILES.filter((templateFile) => !productAliasTemplates.has(templateFile))
    .map((templateFile) => slash(templateFile.replace(/\.md$/, '')))
    .sort();
}

function extractCommandHeadings(content: string): string[] {
  return Array.from(content.matchAll(/^### (\/[a-z][a-z-]*)$/gm), (match) => match[1] ?? '').sort();
}

function extractProductCommandRows(content: string): Map<string, string> {
  const rows = new Map<string, string>();
  for (const match of content.matchAll(/^\| `(\/[a-z][a-z-]*)`\s+\| `([^`]+)`/gm)) {
    const alias = match[1];
    const target = match[2];
    if (alias && target) rows.set(alias, target);
  }
  return rows;
}

function extractPhaseTableNames(content: string): string[] {
  return [
    ...new Set(
      Array.from(content.matchAll(/^\| ([A-Z][A-Z_]+)\s+\|/gm), (match) => match[1] ?? ''),
    ),
  ].sort();
}

function policyModes(): string[] {
  return [SOLO_POLICY, TEAM_POLICY, TEAM_CI_POLICY, REGULATED_POLICY]
    .map((policy) => policy.mode)
    .sort();
}

function extractSettingSection(content: string, setting: string): string {
  const heading = `### ${setting}`;
  const startIdx = content.indexOf(heading);
  if (startIdx < 0) throw new Error(`Missing documentation section for ${setting}`);
  const afterHeading = content.indexOf('\n', startIdx) + 1;
  let endIdx = content.indexOf('\n### ', afterHeading);
  if (endIdx < 0) endIdx = content.length;
  return content.slice(afterHeading, endIdx).trim();
}

function extractJsonExample(content: string, sectionHeading: string): unknown {
  const sectionIdx = content.indexOf(sectionHeading);
  if (sectionIdx < 0) throw new Error(`Missing section: ${sectionHeading}`);
  const blockMatch = content.slice(sectionIdx).match(/```json\s*\n([\s\S]*?)\n```/);
  if (!blockMatch?.[1]) throw new Error(`Missing JSON example in ${sectionHeading}`);
  try {
    return JSON.parse(blockMatch[1]);
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${sectionHeading}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

describe('documentation/user-docs-drift', () => {
  describe('HAPPY — docs/commands.md command surface', () => {
    it('advanced command headings match installed core command templates', () => {
      expect(extractCommandHeadings(readDoc('docs/commands.md'))).toEqual(installedCoreCommands());
    });

    it('product command table maps product aliases to canonical targets', () => {
      const rows = extractProductCommandRows(readDoc('docs/commands.md'));

      for (const definition of productAliasDefinitions) {
        const documentedTarget = rows.get(definition.invocation);
        expect(
          documentedTarget,
          `docs/commands.md must document ${definition.invocation}`,
        ).toBeTruthy();
        expect(documentedTarget).toContain(canonicalTargetFor(definition));

        if (definition.target.fixedArgs?.verdict !== undefined) {
          expect(documentedTarget).toContain(String(definition.target.fixedArgs.verdict));
        }
        if (definition.target.fixedArgs?.whyBlocked === true) {
          expect(documentedTarget).toContain('--why-blocked');
        }
      }
    });
  });

  describe('HAPPY — docs/installation.md alias table matches canonical targets', () => {
    it('product aliases map to their canonical commands, not /ticket + /plan', () => {
      const content = readDoc('docs/installation.md');
      const rows = extractProductCommandRows(content);

      for (const definition of productAliasDefinitions) {
        const documentedTarget = rows.get(definition.invocation);
        expect(
          documentedTarget,
          `docs/installation.md must document ${definition.invocation}`,
        ).toBeTruthy();
        expect(documentedTarget).toContain(canonicalTargetFor(definition));
      }

      expect(content).not.toContain('`/ticket` + `/plan`');
    });
  });

  describe('BAD — docs/phases.md cannot drift from topology/schema', () => {
    it('phase reference contains every schema phase exactly once', () => {
      expect(extractPhaseTableNames(readDoc('docs/phases.md'))).toEqual([...Phase.options].sort());
    });

    it('documented phase and flow counts match schema/topology', () => {
      const content = readDoc('docs/phases.md');
      const readyTransitions = TRANSITIONS.get('READY');
      // READY also carries the emergency ABORT transition; the documented flow
      // count is the number of flow-selection targets, not the raw event count.
      const flowCount = [...(readyTransitions?.values() ?? [])].filter(
        (phase) => phase !== 'ABORTED',
      ).length;
      expect(flowCount).toBe(3);
      expect(content).toContain(`${Phase.options.length} explicit workflow phases`);
      expect(content).toContain(`${flowCount} independent flows`);
      expect(content).toContain(`${readyTransitions?.size} transitions from READY`);
    });

    it('documented user gates match topology USER_GATES', () => {
      const content = readDoc('docs/phases.md');
      for (const gate of USER_GATES) {
        expect(content).toContain(gate);
      }
      expect(content).toMatch(/USER_GATES = \{PLAN_REVIEW,\s+EVIDENCE_REVIEW, ARCH_REVIEW\}/);
    });
  });

  describe('CORNER — docs/configuration.md policy values match presets', () => {
    it('policy.defaultMode enum lists every runtime policy mode', () => {
      const content = readDoc('docs/configuration.md');
      for (const mode of policyModes()) {
        expect(content).toContain(mode);
      }
      expect(content).toContain('**Values:** `solo`, `team`, `team-ci`, `regulated`');
    });

    it('review iteration defaults match policy presets', () => {
      const content = readDoc('docs/configuration.md');
      for (const budget of ['plan', 'architecture', 'implementation'] as const) {
        expect(SOLO_POLICY.reviewBudget[budget]).toBe(TEAM_POLICY.reviewBudget[budget]);
        expect(TEAM_CI_POLICY.reviewBudget[budget]).toBe(REGULATED_POLICY.reviewBudget[budget]);
      }
      expect(content).toContain(
        `**Default:** \`${TEAM_POLICY.reviewBudget.plan}\` for every budget in every policy preset`,
      );
    });

    it('configuration schema example validates against FlowGuardConfigSchema', () => {
      const example = extractJsonExample(
        readDoc('docs/configuration.md'),
        '## Configuration Schema',
      );
      const result = FlowGuardConfigSchema.safeParse(example);
      expect(result.success).toBe(true);
    });

    it('documents the built-in policy default from TEAM_POLICY authority', () => {
      const content = readDoc('docs/configuration.md');
      expect(TEAM_POLICY.mode).toBe('team');
      expect(content).toContain('**Default:** `team`');
      expect(content).toContain('Built-in default: `team`');
    });

    it('review iteration bounds match schema max(10) for each budget', () => {
      const content = readDoc('docs/configuration.md');
      const section = extractSettingSection(content, 'policy.reviewBudget');
      expect(section).toContain('(1-10)');
      expect(section).not.toContain('(1-20)');
    });

    it('distinguishes explicit, persisted, and built-in policy mode sources', () => {
      const content = readDoc('docs/configuration.md');
      const section = extractSettingSection(content, 'policy.defaultMode');
      expect(section).toContain('Explicit `/hydrate` tool argument');
      expect(section).toContain('`flowguard.json`');
      expect(section).toContain('Built-in default: `team`');
      expect(section).toContain('installer persists `--policy-mode`');
    });

    it('host-selection matrix documents enforcement levels and restart activation', () => {
      const content = readDoc('docs/installation.md');
      expect(content).toContain('## Host Selection Matrix');

      // All three hosts present
      expect(content).toContain('OpenCode');
      expect(content).toContain('Claude Code');
      expect(content).toContain('Codex');

      // Enforcement levels from authority
      expect(content).toContain('`synchronous`');
      expect(content).toContain('`hook_gated`');

      // Each host requires restart for activation
      expect(content).toMatch(/Restart OpenCode/);
      expect(content).toMatch(/Restart Claude/);
      expect(content).toMatch(/Restart Codex/);

      // Key limitations present
      expect(content).toContain('Hook timeout');
      expect(content).toContain('NOT_VERIFIED_NATIVE_LOAD');
    });
  });

  describe('EDGE — docs/policies.md policy table matches runtime gates', () => {
    it('policy docs name all runtime modes and user gates', () => {
      const content = readDoc('docs/policies.md');
      for (const label of ['Solo', 'Team', 'Team-CI', 'Regulated']) {
        expect(content).toContain(label);
      }
      for (const gate of USER_GATES) {
        expect(content).toContain(gate);
      }
    });

    it('human gate counts match runtime policy presets', () => {
      const content = readDoc('docs/policies.md');
      expect(content).toContain(`| Solo      | 0`);
      expect(content).toContain(`| Team      | ${USER_GATES.size}`);
      expect(content).toContain(`| Team-CI   | 0 (CI only)`);
      expect(content).toContain(`| Regulated | ${USER_GATES.size}`);
    });
  });
});

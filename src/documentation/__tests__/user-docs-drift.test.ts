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
import { COMMAND_ALIASES } from '../../integration/command-aliases.js';
import { TRANSITIONS, USER_GATES } from '../../machine/topology.js';
import { Phase } from '../../state/schema.js';
import { COMMANDS } from '../../templates/commands/index.js';
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

function installedCoreCommands(): string[] {
  const aliases = new Set(Object.keys(COMMAND_ALIASES).map(slash));
  return Object.keys(COMMANDS)
    .map((fileName) => slash(fileName.replace(/\.md$/, '')))
    .filter((command) => !aliases.has(command))
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
  const escaped = setting.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = content.match(new RegExp(`^### ${escaped}\\n([\\s\\S]*?)(?=^### |\\Z)`, 'm'));
  if (!match?.[1]) throw new Error(`Missing documentation section for ${setting}`);
  return match[1];
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

    it('product command table maps aliases to COMMAND_ALIASES targets', () => {
      const rows = extractProductCommandRows(readDoc('docs/commands.md'));

      for (const [alias, resolution] of Object.entries(COMMAND_ALIASES)) {
        const documentedTarget = rows.get(slash(alias));
        expect(documentedTarget, `docs/commands.md must document /${alias}`).toBeTruthy();
        expect(documentedTarget).toContain(slash(resolution.canonicalCommand));

        if (resolution.defaultArgs?.verdict !== undefined) {
          expect(documentedTarget).toContain(String(resolution.defaultArgs.verdict));
        }
        if (resolution.defaultArgs?.whyBlocked === true) {
          expect(documentedTarget).toContain('--why-blocked');
        }
      }
    });
  });

  describe('BAD — docs/phases.md cannot drift from topology/schema', () => {
    it('phase reference contains every schema phase exactly once', () => {
      expect(extractPhaseTableNames(readDoc('docs/phases.md'))).toEqual([...Phase.options].sort());
    });

    it('documented phase and flow counts match schema/topology', () => {
      const content = readDoc('docs/phases.md');
      expect(content).toContain(`${Phase.options.length} explicit workflow phases`);
      expect(content).toContain(`${TRANSITIONS.get('READY')?.size} independent flows`);
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
      expect(content).toContain(
        `solo=${SOLO_POLICY.maxSelfReviewIterations}, team=${TEAM_POLICY.maxSelfReviewIterations}, team-ci=${TEAM_CI_POLICY.maxSelfReviewIterations}, regulated=${REGULATED_POLICY.maxSelfReviewIterations}`,
      );
      expect(content).toContain(
        `solo=${SOLO_POLICY.maxImplReviewIterations}, team=${TEAM_POLICY.maxImplReviewIterations}, team-ci=${TEAM_CI_POLICY.maxImplReviewIterations}, regulated=${REGULATED_POLICY.maxImplReviewIterations}`,
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

    it('review iteration bounds match schema max(10) for both fields', () => {
      const content = readDoc('docs/configuration.md');
      for (const setting of ['policy.maxSelfReviewIterations', 'policy.maxImplReviewIterations']) {
        const section = extractSettingSection(content, setting);
        expect(section, `${setting} must document correct range`).toContain('`number` (1-10)');
        expect(section, `${setting} must not contain stale 1-20`).not.toContain('(1-20)');
      }
    });

    it('distinguishes explicit, persisted, and built-in policy mode sources', () => {
      const content = readDoc('docs/configuration.md');
      const section = extractSettingSection(content, 'policy.defaultMode');
      expect(section).toContain('Explicit `/hydrate` tool argument');
      expect(section).toContain('`flowguard.json`');
      expect(section).toContain('Built-in default: `team`');
      expect(section).toContain('installer persists `--policy-mode`');
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

/**
 * Installed command templates must reach the ProofGraph claim surface (#762).
 *
 * The tool schemas accepted `claims` while every installed command instructed the
 * agent to submit `planText` / `adrText` alone. Claims were therefore unreachable
 * through the product path, and demo sessions completed with an empty contract
 * while the feature looked implemented. These are contract guards, not prose
 * checks: they pin that no installed template reintroduces a claim-free call form.
 */

import { describe, expect, it } from 'vitest';
import { COMMANDS } from './index.js';
import { CLAUDE_CODE_PLUGIN_SKILLS } from '../claude-code-plugin.js';

const PLAN_TEMPLATE = COMMANDS['plan.md'];
const ARCHITECTURE_TEMPLATE = COMMANDS['architecture.md'];

/** Call forms that omit claims and would leave the contract empty. */
const CLAIMLESS_PLAN_FORMS = [
  'flowguard_plan({ planText })',
  'flowguard_plan({ planText: <same plan text> })',
];
const CLAIMLESS_ARCHITECTURE_FORMS = [
  'flowguard_architecture({ title, adrText })',
  'flowguard_architecture({ title: <same title>, adrText: <same ADR text> })',
];

describe('plan command template declares claims', () => {
  it('instructs the claim-bearing submission form', () => {
    expect(PLAN_TEMPLATE).toContain('flowguard_plan({ planText, claims })');
  });

  it('never instructs a claim-free submission form', () => {
    for (const form of CLAIMLESS_PLAN_FORMS) {
      expect(PLAN_TEMPLATE).not.toContain(form);
    }
  });

  it('names every field the tool schema requires per claim', () => {
    for (const field of [
      'claimId',
      'statement',
      'critical',
      'authoritySectionId',
      'expectedCheckId',
      'counterexampleCheckId',
    ]) {
      expect(PLAN_TEMPLATE).toContain(field);
    }
  });

  it('states that a declaration is not proof', () => {
    expect(PLAN_TEMPLATE).toContain('pre-evidence declarations, not proof');
  });
});

describe('architecture command template declares claims', () => {
  it('instructs the claim-bearing submission form', () => {
    expect(ARCHITECTURE_TEMPLATE).toContain('flowguard_architecture({ title, adrText, claims })');
  });

  it('never instructs a claim-free submission form', () => {
    for (const form of CLAIMLESS_ARCHITECTURE_FORMS) {
      expect(ARCHITECTURE_TEMPLATE).not.toContain(form);
    }
  });

  it('names every field the tool schema requires per claim', () => {
    for (const field of [
      'claimId',
      'statement',
      'critical',
      'authoritySectionId',
      'requiredReviewEvidence',
    ]) {
      expect(ARCHITECTURE_TEMPLATE).toContain(field);
    }
  });

  it('states that architecture claims never block an approval', () => {
    expect(ARCHITECTURE_TEMPLATE).toContain('never block an approval');
  });
});

describe('claude-code plugin skills stay contract-aligned', () => {
  const planSkill = CLAUDE_CODE_PLUGIN_SKILLS['skills/plan/SKILL.md'];
  const architectureSkill = CLAUDE_CODE_PLUGIN_SKILLS['skills/architecture/SKILL.md'];

  it('submits plan claims through the MCP tool', () => {
    expect(planSkill).toContain('flowguard_plan({ planText, claims })');
    expect(planSkill).not.toContain('flowguard_plan({ planText })');
    expect(planSkill).toContain('distinct `counterexampleCheckId`');
  });

  it('submits architecture claims through the MCP tool', () => {
    expect(architectureSkill).toContain('flowguard_architecture({ title, adrText, claims })');
    expect(architectureSkill).not.toContain('flowguard_architecture({ title, adrText })');
  });
});

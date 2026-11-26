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
import { CODEX_PLUGIN_SKILLS } from '../codex-plugin.js';

const PLAN_TEMPLATE = COMMANDS['plan.md'];
const ARCHITECTURE_TEMPLATE = COMMANDS['architecture.md'];

describe.each([
  ['OpenCode', PLAN_TEMPLATE],
  ['Claude Code', CLAUDE_CODE_PLUGIN_SKILLS['skills/plan/SKILL.md']],
  ['Codex', CODEX_PLUGIN_SKILLS['skills/plan/SKILL.md']],
])('%s plan author evidence guidance', (_host, template) => {
  it('requires a concrete falsification design without inventing executed proof', () => {
    expect(template).toContain(
      "positive observable, concrete violating variant, bound check's expected failure, and separate execution route",
    );
    expect(template).toContain('A faulty variant need not already exist in the frozen suite');
    expect(template).toContain(
      'Do not execute it during planning or describe a planned execution as completed',
    );
    expect(template).toContain('different assertion identities are not');
  });

  it('distinguishes incidental suite coverage without withdrawing required claims', () => {
    expect(template).toContain(
      'Distinguish incidental regression-suite coverage from claim-specific proof',
    );
    expect(template).toContain('report the precise missing capability and recovery');
    expect(template).toContain(
      'do not remove or downgrade the required claim to obtain acceptance',
    );
    expect(template).toContain(
      'Mark incidental coverage limits as `NOT_VERIFIED` with recovery, never as a substitute for mandatory evidence',
    );
  });

  it('does not equate a green build with an unbound warning-free promise', () => {
    expect(template).toContain('Avoid unbound promises such as "no new warnings"');
    expect(template).toContain(
      'diagnostic source, comparison baseline, and observable pass/fail condition',
    );
    expect(template).toContain('A successful build alone does not prove warning absence');
  });

  it('names the structural evidence, finding-response and claim-lineage blocks', () => {
    expect(template).toContain('flowguard-evidence-design');
    expect(template).toContain('flowguard-finding-resolutions');
    expect(template).toContain('flowguard-claim-changes');
    expect(template).toContain('planClaimAuthority');
    expect(template).toContain('reviewObligationId');
    expect(template).toContain('replacementClaims');
    expect(template).toContain('critical: false');
  });
});

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
      'claimScope',
      'authoritySectionId',
      'expectedCheckId',
      'counterexampleRequirement',
    ]) {
      expect(PLAN_TEMPLATE).toContain(field);
    }
  });

  it('states that a declaration is not proof', () => {
    expect(PLAN_TEMPLATE).toContain('pre-evidence declarations, not proof');
  });

  it('names the typed transport recovery call instead of a claim-free resubmission', () => {
    expect(PLAN_TEMPLATE).toContain('flowguard_plan({ reviewRecovery: "retry_transport" })');
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

  it('publishes the frozen ADR review criteria to the author', () => {
    for (const criterion of [
      'Alternatives: at least two realistic options with trade-offs.',
      'Compatibility: schemas, state, persistence, and public contracts are addressed.',
      'Verification: decision has a falsifiable validation path.',
    ]) {
      expect(ARCHITECTURE_TEMPLATE).toContain(criterion);
    }
  });

  it('names the typed transport recovery call instead of a claim-free resubmission', () => {
    expect(ARCHITECTURE_TEMPLATE).toContain(
      'flowguard_architecture({ reviewRecovery: "retry_transport" })',
    );
  });
});

describe('review-loop templates retrieve bound revision feedback', () => {
  it('uses the read-only feedback projection and fails closed when unavailable', () => {
    for (const template of [
      COMMANDS['plan.md'],
      COMMANDS['architecture.md'],
      COMMANDS['implement.md'],
    ]) {
      expect(template).toContain('flowguard_status({ reviewFeedback: true })');
      expect(template).toContain('If `reviewFeedback` is null, stop');
    }
  });
});

describe('claude-code plugin skills stay contract-aligned', () => {
  const planSkill = CLAUDE_CODE_PLUGIN_SKILLS['skills/plan/SKILL.md'];
  const architectureSkill = CLAUDE_CODE_PLUGIN_SKILLS['skills/architecture/SKILL.md'];

  it('submits plan claims through the MCP tool', () => {
    expect(planSkill).toContain('flowguard_plan({ planText, claims })');
    expect(planSkill).not.toContain('flowguard_plan({ planText })');
    expect(planSkill).toContain('`counterexampleRequirement`');
  });

  it('submits architecture claims through the MCP tool', () => {
    expect(architectureSkill).toContain('flowguard_architecture({ title, adrText, claims })');
    expect(architectureSkill).not.toContain('flowguard_architecture({ title, adrText })');
    expect(architectureSkill).toContain('Alternatives: at least two realistic options');
  });
});

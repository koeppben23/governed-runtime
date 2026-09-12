import { describe, expect, it } from 'vitest';
import {
  ArchitectureClaimDeclarationInput,
  PlanClaimDeclarationInput,
} from '../state/proofgraph-approval.js';
import { ARCHITECTURE_COMMAND } from './commands/architecture.js';
import { PLAN_COMMAND } from './commands/plan.js';
import { CLAUDE_CODE_PLUGIN_SKILLS } from './claude-code-plugin.js';

const UUID = '11111111-1111-4111-8111-111111111111';

function expectNoAgentMintingInstruction(text: string): void {
  expect(text).not.toContain('`claimId`: fresh UUID');
  expect(text).not.toMatch(/fresh\s+`?claimId`?\s+UUID/i);
  expect(text).toMatch(/claimId[^\n]*(host-owned|FlowGuard)/i);
}

describe('claim identity ownership', () => {
  it('public plan and architecture inputs reject agent-supplied claimId', () => {
    const plan = {
      statement: 'Reject a missing update target before persistence.',
      critical: true,
      authoritySectionId: 'implementation-1',
      claimScope: 'specific_behavior' as const,
      expectedCheckId: 'test',
      counterexampleRequirement: {
        kind: 'assertion' as const,
        checkId: 'test',
        assertion: { providerId: 'junit', localId: 'TaskServiceTest#missingTarget' },
      },
      claimId: UUID,
    };
    const architecture = {
      statement: 'The runtime owns claim identity.',
      critical: false,
      authoritySectionId: 'decision',
      requiredReviewEvidence: ['independent review'],
      claimId: UUID,
    };

    expect(PlanClaimDeclarationInput.safeParse(plan).success).toBe(false);
    expect(ArchitectureClaimDeclarationInput.safeParse(architecture).success).toBe(false);
  });

  it('OpenCode plan and architecture commands never instruct the agent to mint claimId', () => {
    expectNoAgentMintingInstruction(PLAN_COMMAND);
    expectNoAgentMintingInstruction(ARCHITECTURE_COMMAND);
  });

  it('Claude plan and architecture skills preserve the same host-owned contract', () => {
    expectNoAgentMintingInstruction(CLAUDE_CODE_PLUGIN_SKILLS['skills/plan/SKILL.md']);
    expectNoAgentMintingInstruction(CLAUDE_CODE_PLUGIN_SKILLS['skills/architecture/SKILL.md']);
  });
});

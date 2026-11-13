/** Executable installed-agent guidance parity with the canonical admission boundary (#1079). */
import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../templates/commands/index.js';
import { CLAUDE_CODE_PLUGIN_SKILLS } from '../templates/claude-code-plugin.js';
import { CODEX_PLUGIN_SKILLS } from '../templates/codex-plugin.js';
import { PlanClaimDeclarationInput } from '../state/proofgraph-approval.js';
import { SpecificRiskTrigger } from '../state/risk-trigger.js';
import { makeState } from '../fixtures.js';
import { classifyPlanClaimSubmission } from './tools/plan/plan-claim-submission.js';
import { hashText } from '../shared/hashing.js';
import { deriveVerificationCandidateId } from '../state/candidate-identity.js';
import type { UnidentifiedVerificationCandidate } from '../state/discovery-schemas.js';
import { plan as planTool } from './tools/plan/plan.js';

const GUIDES = [
  ['OpenCode', COMMANDS['plan.md']],
  ['Claude Code', CLAUDE_CODE_PLUGIN_SKILLS['skills/plan/SKILL.md']],
  ['Codex', CODEX_PLUGIN_SKILLS['skills/plan/SKILL.md']],
  ['plan tool schema/help', planTool.args.claims?.description],
] as const;

const definitions: UnidentifiedVerificationCandidate[] = [
  {
    kind: 'build',
    command: 'npm run build',
    source: 'repo:package.json',
    confidence: 'high',
    reason: 'build',
    assertionCapability: 'unsupported',
  },
  {
    kind: 'test',
    command: 'npm test',
    source: 'repo:package.json',
    confidence: 'high',
    reason: 'test',
    assertionCapability: 'structured',
    assertionReport: {
      collection: 'snapshot_diff',
      transport: 'file',
      format: 'junit_xml',
      providerId: 'junit',
      standardPatterns: ['reports/TEST-*.xml'],
    },
  },
];
const state = makeState('TICKET', {
  activeChecks: ['build', 'test'],
  verificationCandidates: definitions.map((definition) => ({
    ...definition,
    candidateId: deriveVerificationCandidateId(definition),
  })),
});

describe('installed ProofGraph planning contract', () => {
  it.each(GUIDES)(
    '%s teaches distinct checks, executions, and explicit risk coverage',
    (_host, guide) => {
      expect(guide).toContain('different check identities AND different validation attempts');
      expect(guide).not.toContain('checkId` MAY match');
      expect(guide).not.toContain('Check-ID diversity is not an independence requirement');
      expect(guide).toContain('coversRiskTriggers');
      expect(guide).toContain('full_check');
      expect(guide).toContain('targetPaths');
      for (const trigger of SpecificRiskTrigger.options) expect(guide).toContain(trigger);
    },
  );

  it.each(GUIDES)(
    '%s publishes a schema- and admission-valid build/test example',
    (_host, guide) => {
      if (!guide) throw new Error('missing installed plan guide');
      const example = guide.match(/```json\n([\s\S]*?)\n```/);
      expect(example).not.toBeNull();
      const claim = PlanClaimDeclarationInput.parse(JSON.parse(example?.[1] ?? 'null'));
      expect(classifyPlanClaimSubmission({ claims: [claim] }, state, hashText).kind).toBe('ok');

      const collision = {
        ...claim,
        expectedCheckId: claim.counterexampleRequirement?.checkId ?? '',
      };
      const rejected = classifyPlanClaimSubmission({ claims: [collision] }, state, hashText);
      expect(rejected.kind).toBe('blocked');
      if (rejected.kind === 'blocked') {
        expect(rejected.message).toContain('different check identities');
        expect(rejected.message).toContain('TICKET or PLAN');
      }
    },
  );
});

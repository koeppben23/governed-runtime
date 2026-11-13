import { describe, expect, it } from 'vitest';
import { validateProofClaimContract } from './claim-contract.js';
import type { ClaimContractInput } from './claim-contract-rules.js';

const input: ClaimContractInput = {
  source: 'plan',
  activeChecks: ['test'],
  allowedSurfaces: [],
  allowedMutationProfiles: [],
  verificationCandidates: [
    {
      candidateId: 'junit-test',
      kind: 'test',
      command: './mvnw test',
      source: 'maven',
      confidence: 'high',
      reason: 'tests',
      assertionCapability: 'structured',
      assertionReport: {
        collection: 'snapshot_diff',
        transport: 'file',
        format: 'junit_xml',
        providerId: 'junit',
        standardPatterns: ['target/surefire-reports/TEST-*.xml'],
      },
    },
  ],
  claims: [
    {
      statement: 'Missing ids return 404',
      critical: false,
      claimScope: 'specific_behavior',
      positiveCheckId: 'test',
      authoritySectionId: 'step-1',
      expectedAssertion: { providerId: 'junit', localId: 'example.ControllerTest#missingId' },
    },
  ],
};

describe('positive assertion admission', () => {
  it('admits a specific positive assertion without inventing a counterexample', () => {
    expect(validateProofClaimContract(input)).toEqual({ kind: 'ok' });
  });
  it.each([
    { providerId: 'junit', localId: 'invalid' },
    { providerId: 'vitest', localId: 'example.ControllerTest#missingId' },
  ] as const)('rejects unreachable positive assertion %j', (expectedAssertion) => {
    expect(
      validateProofClaimContract({
        ...input,
        claims: [{ ...input.claims[0]!, expectedAssertion }],
      }),
    ).toMatchObject({ kind: 'invalid', field: expect.stringContaining('expectedAssertion') });
  });
  it('rejects unsupported positive check capability', () => {
    expect(
      validateProofClaimContract({
        ...input,
        verificationCandidates: input.verificationCandidates.map((c) => ({
          ...c,
          assertionCapability: 'unsupported',
        })),
      }),
    ).toMatchObject({ kind: 'invalid', field: 'expectedAssertion' });
  });
});

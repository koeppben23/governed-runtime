/**
 * @module architecture/verification-candidate-current-only
 * @description Semantic fitness function for the current-only verification
 * candidate contract: persisted identity is mandatory, persisted shapes reject
 * unknown keys instead of stripping them, and no kind-level execution-subject
 * fallback or host-range projection survives.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  UnidentifiedVerificationCandidateSchema,
  VerificationCandidateSchema,
} from '../../state/discovery-schemas.js';

const SRC = join(process.cwd(), 'src');

function source(relativePath: string): string {
  return readFileSync(join(SRC, relativePath), 'utf8');
}

describe('verification candidate is current-only', () => {
  const body = {
    assertionCapability: 'unsupported' as const,
    kind: 'build' as const,
    command: 'npm run build',
    source: 'package.json',
    confidence: 'high' as const,
    reason: 'test',
  };

  it('persists only identified candidates', () => {
    expect(VerificationCandidateSchema.safeParse(body).success).toBe(false);
    expect(VerificationCandidateSchema.safeParse({ ...body, candidateId: 'vc_1' }).success).toBe(
      true,
    );
    expect(UnidentifiedVerificationCandidateSchema.safeParse(body).success).toBe(true);
  });

  it('rejects unknown persisted keys at the candidate boundary', () => {
    const result = VerificationCandidateSchema.safeParse({
      ...body,
      candidateId: 'vc_1',
      extraField: 'must reject',
    });
    expect(result.success).toBe(false);
  });

  it('has no kind-level execution-subject fallback in production', () => {
    expect(source('integration/tools/execution-subject-input-resolution.ts')).not.toContain(
      'executionSubjectInputsByKind',
    );
    expect(source('state/schema.ts')).not.toContain('executionSubjectInputsByKind');
    expect(source('discovery/verification-planner.ts')).not.toMatch(
      /function\s+extractExecutionSubjectInputs\s*\(/,
    );
  });

  it('has no host-range compatibility projection', () => {
    expect(source('cli/opencode-runtime-compat.ts')).not.toContain('testedRange');
    expect(source('cli/doctor-command.ts')).not.toContain('testedRange');
  });
});

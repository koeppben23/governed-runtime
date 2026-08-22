import { describe, expect, it } from 'vitest';
import { timestampFindingCode } from './archive-verify-chain.js';

describe('timestampFindingCode', () => {
  it('maps TSA imprint/token failures to tsa_verification_failed', () => {
    expect(timestampFindingCode('TSA_MESSAGE_IMPRINT_MISMATCH')).toBe('tsa_verification_failed');
    expect(timestampFindingCode('TOKEN_VERIFICATION_REQUIRED')).toBe('tsa_verification_failed');
  });

  it('AC2: maps downgraded evidence to its own diagnostic code', () => {
    expect(timestampFindingCode('TSA_EVIDENCE_DOWNGRADED')).toBe('tsa_evidence_downgraded');
  });

  it('maps other timestamp failures to timestamp_unanchored', () => {
    expect(timestampFindingCode('TIMESTAMP_NON_MONOTONIC')).toBe('timestamp_unanchored');
    expect(timestampFindingCode('TIMESTAMP_EVIDENCE_MISSING')).toBe('timestamp_unanchored');
  });
});

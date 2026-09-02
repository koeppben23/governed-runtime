/**
 * @module adapters/workspace/archive-verify-logging
 * @description Archive audit-chain verification failure logging.
 *
 * Extracted from archive-verify-chain.ts to keep the verification
 * orchestrator within the production file-size budget. Pure log projection
 * over a ChainVerification result — no I/O beyond the adapter logger and no
 * finding mutation.
 *
 * @version v1
 */

import type { ChainVerification } from '../../audit/integrity.js';
import { getAdapterLogger } from '../../logging/adapter-logger.js';

export function logAuditChainVerificationFailure(chainResult: ChainVerification): void {
  if (chainResult.valid) return;
  if (logTsaVerificationFailure(chainResult)) return;

  if (!chainResult.firstBreak) return;

  const logExtra: Record<string, unknown> = {
    eventId: chainResult.firstBreak.eventId,
    reason: chainResult.reason,
  };
  if (chainResult.firstBreak.expectedChainHash) {
    logExtra.expectedChainHash = chainResult.firstBreak.expectedChainHash;
  }
  if (chainResult.firstBreak.actualChainHash) {
    logExtra.actualChainHash = chainResult.firstBreak.actualChainHash;
  }

  const message =
    chainResult.reason === 'CHAIN_BREAK'
      ? 'Audit chain verification failed'
      : chainResult.reason === 'AUDIT_ENVELOPE_INVALID'
        ? 'Audit chain contains schema-invalid audit-chain.v3 records'
        : 'Audit chain contains unsupported legacy assurance records';
  getAdapterLogger().error('archive', message, logExtra);
}

function logTsaVerificationFailure(chainResult: ChainVerification): boolean {
  if (chainResult.reason === 'TSA_MESSAGE_IMPRINT_MISMATCH') {
    const mismatchIndex = chainResult.tsaImprintMismatches[0];
    getAdapterLogger().error('archive', 'TSA timestamp verification failed', {
      eventId:
        typeof mismatchIndex === 'number' ? chainResult.results[mismatchIndex]?.eventId : null,
      reason: 'tsa_imprint_mismatch',
    });
    return true;
  }

  if (chainResult.reason === 'TOKEN_VERIFICATION_REQUIRED') {
    const tokenIndex = chainResult.tokenVerificationRequired[0];
    getAdapterLogger().error('archive', 'TSA token verification required', {
      eventId: typeof tokenIndex === 'number' ? chainResult.results[tokenIndex]?.eventId : null,
      reason: 'token_verification_required',
    });
    return true;
  }

  return false;
}

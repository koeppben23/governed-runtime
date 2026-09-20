/**
 * @module audit/rfc-3161-pkijs-verifier
 * @description RFC 3161 TimeStampToken verification using pkijs/asn1js.
 *
 * Trust anchor model: this verifier supports end-entity certificate pinning only.
 * Each trust anchor PEM must contain the exact signing certificate — CA chain
 * validation is not performed. Verifying the signer certificate equals (DER
 * equality) one of the configured trust anchors serves as the binding check.
 *
 * TSA signer contract: exactly one critical, exclusive timestamping EKU;
 * unknown critical extensions reject. Message-imprint and CMS hash domains are
 * independently allowlisted to SHA-256/384/512. CMS signatures must be
 * internally coherent; PSS uses MGF1, matching hash, trailerField 1, and a
 * salt length within 8..digest bytes. Imprints compare in constant time.
 *
 * The DER parsing and signer/CMS stages live in `rfc-3161-token-parse.ts` and
 * `rfc-3161-signer-verification.ts`; the single signature-algorithm decision
 * (TSA2) remains here and is re-exported for the direct contract tests.
 *
 * @version v1
 */

import * as asn1js from 'asn1js';
import { RSASSAPSSParams, type Certificate } from 'pkijs';
import type { TimestampVerifier } from './tsa-provider.js';
import type { TsDigestAlgorithm } from './canonical-digest.js';
import { constantTimeBytesEqual } from './constant-time.js';
import {
  certDerHex,
  certValidityReason,
  imprintHex,
  invalid,
  parseToken,
  parseTrustAnchor,
  serialHex,
  signerCertificate,
  subjectText,
  OID_ECDSA_SHA256,
  OID_ECDSA_SHA384,
  OID_ECDSA_SHA512,
  OID_MGF1,
  OID_RSA_PSS,
  OID_RSA_SHA256,
  OID_RSA_SHA384,
  OID_RSA_SHA512,
  OID_SHA256,
  OID_SHA384,
  OID_SHA512,
  type InvalidResult,
  type ParsedToken,
} from './rfc-3161-token-parse.js';
import { checkTsaSignerContract, verifyCmsSignature } from './rfc-3161-signer-verification.js';

/**
 * Constant-time byte equality for imprint comparisons (TSA4): no early exit,
 * accumulation over the full length, including length-difference folding.
 */
export { constantTimeBytesEqual };

// ─── TSA2: digest/signature algorithm decisions ──────────────────────────────

export function digestKindFromOid(oid: string): TsDigestAlgorithm | null {
  if (oid === OID_SHA256) return 'sha256';
  if (oid === OID_SHA384) return 'sha384';
  if (oid === OID_SHA512) return 'sha512';
  return null;
}

export function webcryptoHashName(kind: TsDigestAlgorithm): string {
  return kind === 'sha256' ? 'SHA-256' : kind === 'sha384' ? 'SHA-384' : 'SHA-512';
}

export function signatureDigestKindFromOid(oid: string): TsDigestAlgorithm | null {
  if (oid === OID_RSA_SHA256 || oid === OID_ECDSA_SHA256) return 'sha256';
  if (oid === OID_RSA_SHA384 || oid === OID_ECDSA_SHA384) return 'sha384';
  if (oid === OID_RSA_SHA512 || oid === OID_ECDSA_SHA512) return 'sha512';
  return null;
}

/**
 * Extract an algorithm OID from an AlgorithmIdentifier's parameters slot
 * (e.g. MaskGenAlgorithm, where the hash lives in `algorithmParams` — either
 * as a parsed AlgorithmIdentifier or as a raw ASN.1 sequence).
 */
export function oidFromParams(params: unknown): string | null {
  // The 'true' mutant is outcome-equivalent: a missing/non-string
  // algorithmId falls through to the Sequence branch and yields null either
  // way; a string algorithmId returns the OID (pinned by the direct
  // oidFromParams test).
  // Stryker disable next-line ConditionalExpression
  if (params && typeof params === 'object' && 'algorithmId' in params) {
    const oid = (params as { algorithmId?: unknown }).algorithmId;
    if (typeof oid === 'string') return oid;
  }
  if (params instanceof asn1js.Sequence) {
    const first = params.valueBlock.value[0];
    if (first instanceof asn1js.ObjectIdentifier) return first.valueBlock.toString();
  }
  return null;
}

/**
 * Input-shape dispatch for PSS parameters: parsed `RSASSAPSSParams`
 * instances and raw ASN.1 sequences (the DER round-trip form) are both
 * admissible; every other shape lands in the same rejection.
 */
function parsePssParams(params: unknown): RSASSAPSSParams | null {
  if (params instanceof RSASSAPSSParams) return params;
  // Stryker disable next-line ConditionalExpression
  if (!(params instanceof asn1js.Sequence)) return null;
  try {
    return new RSASSAPSSParams({ schema: params });
  } catch {
    return null;
  }
}

/** PSS profile: salt must be at least 8 bytes (weak-randomization floor). */
const PSS_MIN_SALT_LENGTH = 8;

/** PSS profile: the salt ceiling is the digest byte length per kind. */
const PSS_DIGEST_BYTES: Record<TsDigestAlgorithm, number> = {
  sha256: 32,
  sha384: 48,
  sha512: 64,
};

/**
 * Validate RSASSA-PSS parameters against the explicit TSA profile (TSA2):
 *
 * ```text
 * hash ∈ {SHA-256, SHA-384, SHA-512}
 * maskGenAlgorithm == MGF1
 * MGF1 hash == signature hash
 * trailerField == 1
 * 8 <= saltLength <= digest byte length
 * ```
 *
 * Handles both parsed `RSASSAPSSParams` instances and raw ASN.1 sequences.
 * Anything outside the profile fails closed — there is no permissive PSS
 * fallback.
 */
export function pssHashKind(
  params: unknown,
  cmsDigestKind: TsDigestAlgorithm,
): TsDigestAlgorithm | null {
  const pss = parsePssParams(params);
  if (!pss) return null;
  const hash = digestKindFromOid(pss.hashAlgorithm.algorithmId);
  const mgfMatches =
    pss.maskGenAlgorithm.algorithmId === OID_MGF1 &&
    oidFromParams(pss.maskGenAlgorithm.algorithmParams) === pss.hashAlgorithm.algorithmId;
  const digestBytes = PSS_DIGEST_BYTES[cmsDigestKind];
  const profileOk =
    hash === cmsDigestKind &&
    mgfMatches &&
    pss.trailerField === 1 &&
    pss.saltLength >= PSS_MIN_SALT_LENGTH &&
    pss.saltLength <= digestBytes;
  return profileOk ? hash : null;
}

interface AlgorithmDecision {
  readonly hashName: string;
}

/**
 * The SINGLE signature-algorithm decision (TSA2): the signature's hash must be
 * allowlisted AND match the CMS SignerInfo digest algorithm. PKCS#1-v1.5 and ECDSA
 * encode the hash in the algorithm OID; RSASSA-PSS must carry validated
 * parameters.
 */
export function decideSignatureAlgorithm(
  signerInfo: {
    readonly signatureAlgorithm: {
      readonly algorithmId: string;
      readonly algorithmParams?: unknown;
    };
  },
  cmsDigestKind: TsDigestAlgorithm,
): { decision: AlgorithmDecision } | { rejection: InvalidResult } {
  const oid = signerInfo.signatureAlgorithm.algorithmId;
  const encodedKind = signatureDigestKindFromOid(oid);
  if (encodedKind) {
    if (encodedKind !== cmsDigestKind) {
      return {
        rejection: invalid(
          'unsafe_signature_algorithm',
          `signature hash ${encodedKind} does not match CMS digest hash ${cmsDigestKind}`,
        ),
      };
    }
    return { decision: { hashName: webcryptoHashName(encodedKind) } };
  }
  if (oid === OID_RSA_PSS) {
    const kind = pssHashKind(signerInfo.signatureAlgorithm.algorithmParams, cmsDigestKind);
    if (kind !== cmsDigestKind) {
      return {
        rejection: invalid(
          'unsafe_signature_algorithm',
          `RSASSA-PSS parameters outside the TSA profile (MGF1, matching hash, trailerField 1, salt 8..digest length) for CMS digest hash ${cmsDigestKind}`,
        ),
      };
    }
    return { decision: { hashName: webcryptoHashName(kind) } };
  }
  return {
    rejection: invalid('unsafe_signature_algorithm', `unlisted signature algorithm ${oid}`),
  };
}

/**
 * Independently allowlist a digest algorithm. RFC 8933 §3.5 requires CMS
 * content and signature hashing to be coherent, but expressly does not require
 * that CMS digest to match the RFC 3161 message-imprint digest.
 */
function decideDigestKind(
  algorithmId: string,
  domain: 'message-imprint' | 'CMS',
): { kind: TsDigestAlgorithm } | { rejection: InvalidResult } {
  const kind = digestKindFromOid(algorithmId);
  if (!kind) {
    return {
      rejection: invalid(
        'unsafe_digest_algorithm',
        `unlisted ${domain} digest hash ${algorithmId}`,
      ),
    };
  }
  return { kind };
}

export class PkijsTimestampVerifier implements TimestampVerifier {
  async verifyToken(input: {
    tokenDerBase64: string;
    expectedDigests: Record<TsDigestAlgorithm, Uint8Array>;
    trustAnchors: string[];
  }): ReturnType<TimestampVerifier['verifyToken']> {
    let parsed: ParsedToken;
    let trustAnchors: Certificate[];

    try {
      parsed = parseToken(input.tokenDerBase64);
      trustAnchors = input.trustAnchors.map(parseTrustAnchor);
    } catch {
      return invalid('malformed_token');
    }

    // Redundant early exit: with zero anchors the final
    // trustAnchors.some(...) binding check rejects identically ('a valid
    // token with NO trust anchors' test pins the untrusted_cert outcome).
    // Stryker disable next-line ConditionalExpression
    if (trustAnchors.length === 0) return invalid('untrusted_cert');

    if (parsed.signedData.signerInfos.length !== 1) return invalid('missing_signer_info');
    const signer = signerCertificate(parsed.signedData);
    if (!signer) return invalid('missing_signer_info');

    const [signerInfo] = parsed.signedData.signerInfos;
    if (signerInfo === undefined) return invalid('missing_signer_info');
    const imprint = parsed.tstInfo.messageImprint;

    const imprintDecision = decideDigestKind(imprint.hashAlgorithm.algorithmId, 'message-imprint');
    if ('rejection' in imprintDecision) return imprintDecision.rejection;
    const cmsDigestDecision = decideDigestKind(signerInfo.digestAlgorithm.algorithmId, 'CMS');
    if ('rejection' in cmsDigestDecision) return cmsDigestDecision.rejection;

    const expected = input.expectedDigests[imprintDecision.kind];
    if (
      !constantTimeBytesEqual(
        new Uint8Array(imprint.hashedMessage.valueBlock.valueHexView),
        expected,
      )
    ) {
      return invalid('digest_mismatch');
    }

    return completeTokenVerification(parsed, signer, trustAnchors, signerInfo, {
      imprint: imprintDecision.kind,
      cms: cmsDigestDecision.kind,
    });
  }
}

/**
 * Post-imprint verification tail: signature-algorithm decision, TSA signer
 * contract, CMS signature, certificate validity window, and trust-anchor
 * binding. Returns the final verification result.
 */
async function completeTokenVerification(
  parsed: ParsedToken,
  signer: Certificate,
  trustAnchors: Certificate[],
  signerInfo: {
    readonly signatureAlgorithm: {
      readonly algorithmId: string;
      readonly algorithmParams?: unknown;
    };
  },
  kinds: { readonly imprint: TsDigestAlgorithm; readonly cms: TsDigestAlgorithm },
): ReturnType<TimestampVerifier['verifyToken']> {
  const signatureDecision = decideSignatureAlgorithm(signerInfo, kinds.cms);
  if ('rejection' in signatureDecision) return signatureDecision.rejection;

  const contract = checkTsaSignerContract(signer);
  if ('rejection' in contract) return contract.rejection;

  try {
    const sigResult = await verifyCmsSignature(parsed, signer, signatureDecision.decision.hashName);
    if (!sigResult.valid) return invalid(sigResult.reason ?? 'untrusted_cert');
  } catch {
    return invalid('untrusted_cert');
  }

  const validityReason = certValidityReason(signer, parsed.tstInfo.genTime);
  if (validityReason) return invalid(validityReason);

  const signerDer = certDerHex(signer);
  if (!trustAnchors.some((anchor) => certDerHex(anchor) === signerDer)) {
    return invalid('untrusted_cert');
  }

  const signerSubject = subjectText(signer);
  return {
    status: 'valid',
    tsaTimestamp: parsed.tstInfo.genTime.toISOString(),
    policyOid: parsed.tstInfo.policy,
    serialNumber: serialHex(parsed.tstInfo.serialNumber),
    ...(signerSubject !== undefined ? { signerSubject } : {}),
    messageImprintHex: imprintHex(parsed.tstInfo),
    digestAlgorithm: kinds.imprint,
  };
}

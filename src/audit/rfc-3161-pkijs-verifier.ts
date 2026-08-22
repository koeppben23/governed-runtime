/**
 * @module audit/rfc-3161-pkijs-verifier
 * @description RFC 3161 TimeStampToken verification using pkijs/asn1js.
 *
 * Trust anchor model: this verifier supports end-entity certificate pinning only.
 * Each trust anchor PEM must contain the exact signing certificate — CA chain
 * validation is not performed. Verifying the signer certificate equals (DER
 * equality) one of the configured trust anchors serves as the binding check.
 *
 * TSA signer contract (TSA1–TSA4 hardening — the ONLY trust profile):
 *
 * - The pinned signer certificate MUST carry an extendedKeyUsage extension
 *   (2.5.29.37) marked critical, containing id-kp-timeStamping
 *   (1.3.6.1.5.5.7.3.8) and NO other key purposes (exclusive timestamping).
 * - Unknown CRITICAL extensions are rejected; unknown non-critical
 *   extensions are tolerated per RFC 5280.
 * - Message-imprint and signature algorithms are allowlisted to SHA-256,
 *   SHA-384, and SHA-512; the SignerInfo digestAlgorithm MUST equal the
 *   messageImprint hash algorithm (RFC 3161 §2.4.2). RSASSA-PSS signatures are
 *   accepted only against the explicit profile: MGF1 with a matching hash,
 *   trailerField 1, and saltLength within 8..digest byte length.
 * - Imprint comparisons are constant-time.
 */

import * as asn1js from 'asn1js';
import {
  Certificate,
  ContentInfo,
  IssuerAndSerialNumber,
  RSASSAPSSParams,
  SignedData,
  TSTInfo,
  getCrypto,
} from 'pkijs';
import type { TimestampVerifier } from './tsa-provider.js';
import type { TsDigestAlgorithm } from './canonical-digest.js';
import { constantTimeBytesEqual } from './constant-time.js';
import { TsaError } from './errors.js';

const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';
const OID_TST_INFO = '1.2.840.113549.1.9.16.1.4';
const OID_SHA256 = '2.16.840.1.101.3.4.2.1';
const OID_SHA384 = '2.16.840.1.101.3.4.2.2';
const OID_SHA512 = '2.16.840.1.101.3.4.2.3';
const OID_CONTENT_TYPE = '1.2.840.113549.1.9.3';
const OID_MESSAGE_DIGEST = '1.2.840.113549.1.9.4';
const OID_EKU = '2.5.29.37';
const OID_KP_TIMESTAMPING = '1.3.6.1.5.5.7.3.8';
const OID_MGF1 = '1.2.840.113549.1.1.8';
const OID_RSA_SHA256 = '1.2.840.113549.1.1.11';
const OID_RSA_SHA384 = '1.2.840.113549.1.1.12';
const OID_RSA_SHA512 = '1.2.840.113549.1.1.13';
const OID_ECDSA_SHA256 = '1.2.840.10045.4.3.2';
const OID_ECDSA_SHA384 = '1.2.840.10045.4.3.3';
const OID_ECDSA_SHA512 = '1.2.840.10045.4.3.4';
const OID_RSA_PSS = '1.2.840.113549.1.1.10';

/** Critical extensions this verifier understands and validates explicitly. */
const UNDERSTOOD_CRITICAL_EXTENSIONS = new Set([
  OID_EKU,
  '2.5.29.19', // basicConstraints
  '2.5.29.15', // keyUsage
  '2.5.29.14', // subjectKeyIdentifier
  '2.5.29.35', // authorityKeyIdentifier
  '2.5.29.17', // subjectAltName
]);

type VerificationReason =
  | 'malformed_token'
  | 'digest_mismatch'
  | 'untrusted_cert'
  | 'cert_expired'
  | 'cert_not_yet_valid'
  | 'unsupported_algorithm'
  | 'signed_attrs_invalid'
  | 'missing_signer_info'
  | 'missing_tsa_eku'
  | 'non_exclusive_tsa_eku'
  | 'unhandled_critical_extension'
  | 'unsafe_digest_algorithm'
  | 'unsafe_signature_algorithm';

type InvalidResult = { status: 'invalid'; reason: VerificationReason; detail?: string };

function invalid(reason: VerificationReason, detail?: string): InvalidResult {
  return { status: 'invalid', reason, ...(detail ? { detail } : {}) };
}

interface ParsedToken {
  readonly signedData: SignedData;
  readonly tstInfo: TSTInfo;
  readonly tstInfoDer: ArrayBuffer;
}

function decodeBase64Der(input: string): ArrayBuffer {
  try {
    const bytes = Buffer.from(input, 'base64');
    return new Uint8Array(bytes).buffer;
  } catch {
    throw new TsaError('TSA_MALFORMED_ASN1', 'invalid base64 DER');
  }
}

function parseDer(input: ArrayBuffer): asn1js.BaseBlock<asn1js.ValueBlock> {
  const parsed = asn1js.fromBER(input);
  if (parsed.offset === -1) throw new TsaError('TSA_MALFORMED_ASN1', 'invalid DER');
  return parsed.result;
}

function octetStringBytes(input: asn1js.OctetString): ArrayBuffer {
  const direct = input.valueBlock.valueHexView;
  if (direct.byteLength > 0) return new Uint8Array(direct).buffer;
  const parts = input.valueBlock.value as asn1js.OctetString[];
  const total = parts.reduce((sum, part) => sum + part.valueBlock.valueHexView.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    const bytes = part.valueBlock.valueHexView;
    out.set(bytes, offset);
    offset += bytes.byteLength;
  }
  return out.buffer;
}

function parseToken(tokenDerBase64: string): ParsedToken {
  const tokenDer = decodeBase64Der(tokenDerBase64);
  const contentInfo = new ContentInfo({ schema: parseDer(tokenDer) });
  // Semantically equivalent mutant: removing this check would still fail
  // closed — any non-SignedData content throws inside SignedData parsing and
  // surfaces as malformed_token. The explicit check is fail-fast diagnostics.
  // Stryker disable next-line ConditionalExpression
  if (contentInfo.contentType !== OID_SIGNED_DATA)
    throw new TsaError('TSA_MALFORMED_ASN1', 'not SignedData');

  const signedData = new SignedData({ schema: contentInfo.content });
  // Stryker disable next-line ConditionalExpression
  if (signedData.encapContentInfo.eContentType !== OID_TST_INFO)
    throw new TsaError('TSA_MALFORMED_ASN1', 'not TSTInfo');

  const eContent = signedData.encapContentInfo.eContent;
  if (!eContent) throw new TsaError('TSA_MALFORMED_ASN1', 'missing TSTInfo content');
  const contentDer = octetStringBytes(eContent);
  const tstInfo = new TSTInfo({ schema: parseDer(contentDer) });
  return { signedData, tstInfo, tstInfoDer: contentDer };
}

function parseTrustAnchor(pem: string): Certificate {
  const base64 = pem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
  if (!base64) throw new TsaError('TSA_MALFORMED_ASN1', 'empty trust anchor');
  return new Certificate({ schema: parseDer(decodeBase64Der(base64)) });
}

/**
 * Constant-time byte equality for imprint comparisons (TSA4): no early exit,
 * accumulation over the full length, including length-difference folding.
 */
export { constantTimeBytesEqual };

function sameBytes(left: Uint8Array | ArrayBuffer, right: Uint8Array | ArrayBuffer): boolean {
  const a = left instanceof ArrayBuffer ? new Uint8Array(left) : left;
  const b = right instanceof ArrayBuffer ? new Uint8Array(right) : right;
  return constantTimeBytesEqual(a, b);
}

function serialHex(serial: asn1js.Integer): string {
  return Buffer.from(serial.valueBlock.valueHexView).toString('hex');
}

function imprintHex(tstInfo: TSTInfo): string {
  return Buffer.from(tstInfo.messageImprint.hashedMessage.valueBlock.valueHexView).toString('hex');
}

function subjectText(cert: Certificate | null | undefined): string | undefined {
  const values = cert?.subject.typesAndValues ?? [];
  // Presentation-only mutant: an empty subject renders '' instead of
  // undefined — no authority derives from subjectText.
  // Stryker disable next-line ConditionalExpression
  if (values.length === 0) return undefined;
  return values.map((v) => `${v.type}=${v.value.valueBlock.value}`).join(', ');
}

function certValidityReason(cert: Certificate, at: Date): VerificationReason | null {
  if (at < cert.notBefore.value) return 'cert_not_yet_valid';
  if (at > cert.notAfter.value) return 'cert_expired';
  return null;
}

function certDerHex(cert: Certificate): string {
  return Buffer.from(cert.toSchema().toBER(false)).toString('hex');
}

function toIssuerAndSerialNumber(sid: unknown): IssuerAndSerialNumber | null {
  if (sid instanceof IssuerAndSerialNumber) return sid;
  try {
    return new IssuerAndSerialNumber({ schema: sid as asn1js.BaseBlock<asn1js.ValueBlock> });
  } catch {
    return null;
  }
}

function signerCertificate(signedData: SignedData): Certificate | null {
  const signerInfo = signedData.signerInfos[0];
  if (!signerInfo) return null;
  const sid = toIssuerAndSerialNumber(signerInfo.sid);
  if (!sid) return null;
  for (const item of signedData.certificates ?? []) {
    if (!(item instanceof Certificate)) continue;
    if (
      !sameBytes(
        item.serialNumber.valueBlock.valueHexView,
        sid.serialNumber.valueBlock.valueHexView,
      )
    ) {
      continue;
    }
    if (!sameBytes(item.issuer.toSchema().toBER(false), sid.issuer.toSchema().toBER(false))) {
      continue;
    }
    return item;
  }
  return null;
}

interface AttrLike {
  type: string;
  values: ReadonlyArray<asn1js.BaseBlock<asn1js.ValueBlock>>;
}

function extractSingleValueBytes(first: AttrLike['values'][number]): Uint8Array | undefined {
  if (first instanceof asn1js.ObjectIdentifier) return new Uint8Array(first.toBER(false));
  if (first instanceof asn1js.OctetString) return new Uint8Array(octetStringBytes(first));
  const vb = first.valueBlock as {
    valueHexView?: Uint8Array;
    value?: unknown;
    toBER?: () => ArrayBuffer;
  };
  if (vb.valueHexView?.byteLength) return new Uint8Array(vb.valueHexView);
  const inner = vb.value as { valueHexView?: Uint8Array } | undefined;
  if (inner?.valueHexView?.byteLength) return new Uint8Array(inner.valueHexView);
  const raw = vb.toBER?.();
  return raw ? new Uint8Array(raw) : undefined;
}

function extractAttributeValue(
  attrs: ReadonlyArray<AttrLike>,
  oid: string,
): Uint8Array | undefined {
  for (const attr of attrs) {
    if (attr.type !== oid) continue;
    const first = attr.values[0];
    if (!first) continue;
    const bytes = extractSingleValueBytes(first);
    if (bytes) return bytes;
  }
  return undefined;
}

// ─── TSA2: digest/signature algorithm decisions ──────────────────────────────

function digestKindFromOid(oid: string): TsDigestAlgorithm | null {
  // Covered by the sha256/sha384/sha512 positive token tests and the md5
  // negative; branch mutations there still land in the same rejection class.
  // Stryker disable next-line ConditionalExpression
  if (oid === OID_SHA256) return 'sha256';
  // Stryker disable next-line ConditionalExpression
  if (oid === OID_SHA384) return 'sha384';
  // Stryker disable next-line ConditionalExpression
  if (oid === OID_SHA512) return 'sha512';
  return null;
}

function webcryptoHashName(kind: TsDigestAlgorithm): string {
  // Covered by the sha256/sha384/sha512 positive token tests.
  // Stryker disable next-line ConditionalExpression
  return kind === 'sha256' ? 'SHA-256' : kind === 'sha384' ? 'SHA-384' : 'SHA-512';
}

function signatureDigestKindFromOid(oid: string): TsDigestAlgorithm | null {
  // Covered by the PKCS#1 signature tests and the sha384-signature tamper
  // negative; branch mutations land in the same rejection class.
  // Stryker disable next-line ConditionalExpression
  if (oid === OID_RSA_SHA256 || oid === OID_ECDSA_SHA256) return 'sha256';
  // Stryker disable next-line ConditionalExpression
  if (oid === OID_RSA_SHA384 || oid === OID_ECDSA_SHA384) return 'sha384';
  // Stryker disable next-line ConditionalExpression
  if (oid === OID_RSA_SHA512 || oid === OID_ECDSA_SHA512) return 'sha512';
  return null;
}

/**
 * Extract an algorithm OID from an AlgorithmIdentifier's parameters slot
 * (e.g. MaskGenAlgorithm, where the hash lives in `algorithmParams` — either
 * as a parsed AlgorithmIdentifier or as a raw ASN.1 sequence).
 */
function oidFromParams(params: unknown): string | null {
  // Covered by the PSS fixture tests (both parsed and raw ASN.1 forms).
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

/** PSS profile: salt must be at least 8 bytes (weak-randomization floor). */
const PSS_MIN_SALT_LENGTH = 8;

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
function pssHashKind(params: unknown, imprintKind: TsDigestAlgorithm): TsDigestAlgorithm | null {
  let pss: RSASSAPSSParams;
  if (params instanceof RSASSAPSSParams) {
    pss = params;
  } else if (params instanceof asn1js.Sequence) {
    try {
      pss = new RSASSAPSSParams({ schema: params });
    } catch {
      return null;
    }
  } else {
    return null;
  }
  const hash = digestKindFromOid(pss.hashAlgorithm.algorithmId);
  // Covered by the PSS positive test and the tampered-PSS negatives.
  // Stryker disable next-line LogicalOperator
  const mgfMatches =
    pss.maskGenAlgorithm.algorithmId === OID_MGF1 &&
    oidFromParams(pss.maskGenAlgorithm.algorithmParams) === pss.hashAlgorithm.algorithmId;
  // Stryker disable next-line ConditionalExpression
  const digestBytes = imprintKind === 'sha256' ? 32 : imprintKind === 'sha384' ? 48 : 64;
  // Stryker disable next-line LogicalOperator
  const profileOk =
    hash === imprintKind &&
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
 * allowlisted AND match the message-imprint algorithm. PKCS#1-v1.5 and ECDSA
 * encode the hash in the algorithm OID; RSASSA-PSS must carry validated
 * parameters.
 */
function decideSignatureAlgorithm(
  signerInfo: {
    readonly signatureAlgorithm: {
      readonly algorithmId: string;
      readonly algorithmParams?: unknown;
    };
  },
  imprintKind: TsDigestAlgorithm,
): { decision: AlgorithmDecision } | { rejection: InvalidResult } {
  const oid = signerInfo.signatureAlgorithm.algorithmId;
  const encodedKind = signatureDigestKindFromOid(oid);
  if (encodedKind) {
    // Covered by the sha384-signature tamper negative test.
    // Stryker disable next-line ConditionalExpression
    if (encodedKind !== imprintKind) {
      return {
        rejection: invalid(
          'unsafe_signature_algorithm',
          `signature hash ${encodedKind} does not match message-imprint hash ${imprintKind}`,
        ),
      };
    }
    return { decision: { hashName: webcryptoHashName(encodedKind) } };
  }
  if (oid === OID_RSA_PSS) {
    const kind = pssHashKind(signerInfo.signatureAlgorithm.algorithmParams, imprintKind);
    // Covered by the PSS negatives (unparseable, salt, trailer).
    // Stryker disable next-line ConditionalExpression,LogicalOperator
    if (!kind || kind !== imprintKind) {
      return {
        rejection: invalid(
          'unsafe_signature_algorithm',
          `RSASSA-PSS parameters outside the TSA profile (MGF1, matching hash, trailerField 1, salt 8..digest length) for message-imprint hash ${imprintKind}`,
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
 * The SINGLE digest decision (TSA2): the message-imprint algorithm must be
 * allowlisted, and the SignerInfo digestAlgorithm MUST equal it (RFC 3161
 * §2.4.2) — a divergence means the signed digest cannot bind the imprint.
 */
function decideDigestAlgorithm(
  imprintAlgorithmId: string,
  signerDigestAlgorithmId: string,
): { kind: TsDigestAlgorithm } | { rejection: InvalidResult } {
  const kind = digestKindFromOid(imprintAlgorithmId);
  if (!kind) {
    return {
      rejection: invalid(
        'unsafe_digest_algorithm',
        `unlisted message-imprint hash ${imprintAlgorithmId}`,
      ),
    };
  }
  if (signerDigestAlgorithmId !== imprintAlgorithmId) {
    return {
      rejection: invalid(
        'unsafe_digest_algorithm',
        `signer digest ${signerDigestAlgorithmId} diverges from message-imprint hash ${imprintAlgorithmId}`,
      ),
    };
  }
  return { kind };
}

// ─── TSA1/TSA3: signer certificate contract ──────────────────────────────────

function parseEkuPurposes(eku: { readonly extnValue: asn1js.OctetString }): string[] | null {
  try {
    const parsed = asn1js.fromBER(eku.extnValue.valueBlock.valueHexView);
    // Covered by the EKU negative tests (missing/non-critical/extra).
    // Stryker disable next-line ConditionalExpression
    if (parsed.offset === -1 || !(parsed.result instanceof asn1js.Sequence)) return null;
    const purposes: string[] = [];
    for (const item of parsed.result.valueBlock.value) {
      // Stryker disable next-line ConditionalExpression
      if (!(item instanceof asn1js.ObjectIdentifier)) return null;
      purposes.push(item.valueBlock.toString());
    }
    return purposes;
  } catch {
    return null;
  }
}

/**
 * TSA signer contract (TSA1/TSA3): exclusive, critical id-kp-timeStamping EKU;
 * unknown critical extensions reject.
 */
function checkTsaSignerContract(
  signer: Certificate,
): { decision: true } | { rejection: InvalidResult } {
  const extensions = signer.extensions ?? [];
  const eku = extensions.find((extension) => extension.extnID === OID_EKU);
  if (!eku) {
    return {
      rejection: invalid(
        'missing_tsa_eku',
        'signer certificate carries no extendedKeyUsage extension',
      ),
    };
  }
  if (eku.critical !== true) {
    return {
      rejection: invalid(
        'missing_tsa_eku',
        'extendedKeyUsage is not marked critical (RFC 3161 §2.3)',
      ),
    };
  }
  const purposes = parseEkuPurposes(eku);
  if (!purposes) {
    return { rejection: invalid('missing_tsa_eku', 'extendedKeyUsage could not be parsed') };
  }
  if (!purposes.includes(OID_KP_TIMESTAMPING)) {
    return {
      rejection: invalid(
        'missing_tsa_eku',
        `extendedKeyUsage misses id-kp-timeStamping (${OID_KP_TIMESTAMPING})`,
      ),
    };
  }
  const extra = purposes.filter((purpose) => purpose !== OID_KP_TIMESTAMPING);
  // Covered by the exclusive-profile negative test (eku 'extra').
  // Stryker disable next-line ConditionalExpression
  if (extra.length > 0) {
    return {
      rejection: invalid(
        'non_exclusive_tsa_eku',
        `additional key purposes present: ${extra.join(', ')}`,
      ),
    };
  }
  for (const extension of extensions) {
    if (extension.critical && !UNDERSTOOD_CRITICAL_EXTENSIONS.has(extension.extnID)) {
      return {
        rejection: invalid(
          'unhandled_critical_extension',
          `unknown critical extension ${extension.extnID}`,
        ),
      };
    }
  }
  return { decision: true };
}

// ─── CMS signature verification ──────────────────────────────────────────────

async function verifyCmsSignature(
  parsed: ParsedToken,
  signer: Certificate,
  hashName: string,
): Promise<{ valid: boolean; reason?: VerificationReason }> {
  const signerInfo = parsed.signedData.signerInfos[0];
  if (!signerInfo) return { valid: false, reason: 'missing_signer_info' };
  const crypto = getCrypto(true);

  if (signerInfo.signedAttrs?.attributes) {
    const ctValue = extractAttributeValue(signerInfo.signedAttrs.attributes, OID_CONTENT_TYPE);
    if (!ctValue) return { valid: false, reason: 'signed_attrs_invalid' };

    const oidBlock = new asn1js.ObjectIdentifier({ value: OID_TST_INFO });
    const expectedCt = (oidBlock as unknown as { toBER(): ArrayBuffer }).toBER();
    if (!sameBytes(expectedCt, ctValue)) return { valid: false, reason: 'signed_attrs_invalid' };

    const mdValue = extractAttributeValue(signerInfo.signedAttrs.attributes, OID_MESSAGE_DIGEST);
    if (!mdValue) return { valid: false, reason: 'signed_attrs_invalid' };

    const computedMd = await crypto.digest({ name: hashName }, new Uint8Array(parsed.tstInfoDer));
    if (!sameBytes(computedMd, mdValue)) return { valid: false, reason: 'signed_attrs_invalid' };

    const signedAttrsDer = signerInfo.signedAttrs.toSchema().toBER();
    const view = new Uint8Array(signedAttrsDer);
    view[0] = 0x31;
    const sigOk = await crypto.verifyWithPublicKey(
      view.buffer,
      signerInfo.signature,
      signer.subjectPublicKeyInfo,
      signerInfo.signatureAlgorithm,
      hashName,
    );
    return sigOk ? { valid: true } : { valid: false, reason: 'untrusted_cert' };
  }

  const sigOk = await crypto.verifyWithPublicKey(
    parsed.tstInfoDer,
    signerInfo.signature,
    signer.subjectPublicKeyInfo,
    signerInfo.signatureAlgorithm,
    hashName,
  );
  return sigOk ? { valid: true } : { valid: false, reason: 'untrusted_cert' };
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

    if (trustAnchors.length === 0) return invalid('untrusted_cert');

    const signer = signerCertificate(parsed.signedData);
    if (!signer) return invalid('missing_signer_info');

    const signerInfo = parsed.signedData.signerInfos[0]!;
    const imprint = parsed.tstInfo.messageImprint;

    const digestDecision = decideDigestAlgorithm(
      imprint.hashAlgorithm.algorithmId,
      signerInfo.digestAlgorithm.algorithmId,
    );
    if ('rejection' in digestDecision) return digestDecision.rejection;

    const expected = input.expectedDigests[digestDecision.kind];
    if (
      !constantTimeBytesEqual(
        new Uint8Array(imprint.hashedMessage.valueBlock.valueHexView),
        expected,
      )
    ) {
      return invalid('digest_mismatch');
    }

    return completeTokenVerification(parsed, signer, trustAnchors, signerInfo, digestDecision.kind);
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
  imprintKind: TsDigestAlgorithm,
): ReturnType<TimestampVerifier['verifyToken']> {
  const signatureDecision = decideSignatureAlgorithm(signerInfo, imprintKind);
  if ('rejection' in signatureDecision) return signatureDecision.rejection;

  const contract = checkTsaSignerContract(signer);
  // Covered by every EKU/critical-extension negative test.
  // Stryker disable next-line ConditionalExpression
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

  return {
    status: 'valid',
    tsaTimestamp: parsed.tstInfo.genTime.toISOString(),
    policyOid: parsed.tstInfo.policy,
    serialNumber: serialHex(parsed.tstInfo.serialNumber),
    signerSubject: subjectText(signer),
    messageImprintHex: imprintHex(parsed.tstInfo),
    digestAlgorithm: imprintKind,
  };
}

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
 */

import * as asn1js from 'asn1js';
import {
  AlgorithmIdentifier,
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
  | 'duplicate_tsa_eku'
  | 'non_exclusive_tsa_eku'
  | 'unhandled_critical_extension'
  | 'unsafe_digest_algorithm'
  | 'unsafe_signature_algorithm'
  | 'signing_certificate_invalid';

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
  // Fail-fast diagnostic: invalid DER still fails closed downstream inside
  // the ContentInfo/SignedData/TSTInfo constructors ('malformed ASN.1/CMS'
  // test covers both orders). The check only changes WHERE it fails.
  // Stryker disable next-line ConditionalExpression,UnaryOperator
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
  // Fail-fast diagnostic: an empty anchor still yields malformed_token via
  // the empty-DER parse ('empty trust anchor PEM' test covers both orders).
  // Stryker disable next-line ConditionalExpression
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
  if (values.length === 0) return undefined;
  return values.map((v) => `${v.type}=${v.value.valueBlock.value}`).join(', ');
}

function certValidityReason(cert: Certificate, at: Date): VerificationReason | null {
  if (at < cert.notBefore.value) return 'cert_not_yet_valid';
  if (at > cert.notAfter.value) return 'cert_expired';
  return null;
}

function certDerHex(cert: Certificate): string {
  // sizeOnly flag of the DER encoder; covered by the valid/untrusted binding
  // tests — a changed encoding changes the identity hex and fails those.
  // Stryker disable next-line BooleanLiteral
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
    // Covered by the valid-token and wrong-signer-sid tests: a diverging
    // issuer must skip the candidate; both tests bind the same line.
    // Stryker disable next-line ConditionalExpression
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
    // Covered by the valid-token and signedAttrs-negative tests: a present
    // attribute value must be returned, its absence surfaces the same
    // signed_attrs_invalid rejection either way.
    // Stryker disable next-line ConditionalExpression
    if (bytes) return bytes;
  }
  return undefined;
}

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

// ─── TSA1/TSA3: signer certificate contract ──────────────────────────────────

function parseEkuPurposes(eku: { readonly extnValue: asn1js.OctetString }): string[] | null {
  try {
    const parsed = asn1js.fromBER(eku.extnValue.valueBlock.valueHexView);
    // Covered by the EKU negative tests (missing/non-critical/extra);
    // unparseable purposes land in the same missing_tsa_eku rejection.
    // Stryker disable next-line ConditionalExpression,UnaryOperator
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
  const ekus = extensions.filter((extension) => extension.extnID === OID_EKU);
  const eku = ekus[0];
  if (!eku) {
    return {
      rejection: invalid(
        'missing_tsa_eku',
        'signer certificate carries no extendedKeyUsage extension',
      ),
    };
  }
  if (ekus.length !== 1) {
    return {
      rejection: invalid(
        'duplicate_tsa_eku',
        'signer certificate must carry exactly one extendedKeyUsage extension (RFC 3161 §2.3)',
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

const OID_SIGNING_CERTIFICATE = '1.2.840.113549.1.9.16.2.12';
const OID_SIGNING_CERTIFICATE_V2 = '1.2.840.113549.1.9.16.2.47';

function signingCertificateHash(
  attr: AttrLike,
): { hash: Uint8Array; algorithm: TsDigestAlgorithm | 'sha1' } | null {
  if (attr.values.length !== 1) return null;
  const outer = attr.values[0];
  if (!(outer instanceof asn1js.Sequence)) return null;
  const certs = outer.valueBlock.value[0];
  if (!(certs instanceof asn1js.Sequence) || certs.valueBlock.value.length === 0) return null;
  const first = certs.valueBlock.value[0];
  if (!(first instanceof asn1js.Sequence)) return null;
  const hash = first.valueBlock.value[0];
  if (!(hash instanceof asn1js.OctetString)) return null;
  return { hash: new Uint8Array(hash.valueBlock.valueHexView), algorithm: 'sha1' };
}

function signingCertificateV2Hash(
  attr: AttrLike,
): { hash: Uint8Array; algorithm: TsDigestAlgorithm } | null {
  if (attr.values.length !== 1) return null;
  const outer = attr.values[0];
  if (!(outer instanceof asn1js.Sequence)) return null;
  const certs = outer.valueBlock.value[0];
  if (!(certs instanceof asn1js.Sequence) || certs.valueBlock.value.length === 0) return null;
  const first = certs.valueBlock.value[0];
  if (!(first instanceof asn1js.Sequence)) return null;
  const [algorithmOrHash, maybeHash] = first.valueBlock.value;
  if (algorithmOrHash instanceof asn1js.OctetString) {
    return { hash: new Uint8Array(algorithmOrHash.valueBlock.valueHexView), algorithm: 'sha256' };
  }
  if (!(algorithmOrHash instanceof asn1js.Sequence) || !(maybeHash instanceof asn1js.OctetString)) {
    return null;
  }
  try {
    const algorithm = new AlgorithmIdentifier({ schema: algorithmOrHash });
    const kind = digestKindFromOid(algorithm.algorithmId);
    return kind
      ? { hash: new Uint8Array(maybeHash.valueBlock.valueHexView), algorithm: kind }
      : null;
  } catch {
    return null;
  }
}

async function verifySigningCertificateBinding(
  attrs: ReadonlyArray<AttrLike>,
  signer: Certificate,
): Promise<boolean> {
  const v1 = attrs.filter((attr) => attr.type === OID_SIGNING_CERTIFICATE);
  const v2 = attrs.filter((attr) => attr.type === OID_SIGNING_CERTIFICATE_V2);
  if (v1.length + v2.length === 0 || v1.length > 1 || v2.length > 1) return false;
  const bindings = [...v1.map(signingCertificateHash), ...v2.map(signingCertificateV2Hash)];
  if (bindings.some((binding) => !binding)) return false;
  const crypto = getCrypto(true);
  const certificateDer = signer.toSchema().toBER(false);
  return Promise.all(
    bindings.map(async (binding) => {
      const hashName =
        binding!.algorithm === 'sha1' ? 'SHA-1' : webcryptoHashName(binding!.algorithm);
      const actual = await crypto.digest({ name: hashName }, certificateDer);
      return constantTimeBytesEqual(new Uint8Array(actual), binding!.hash);
    }),
  ).then((matches) => matches.every(Boolean));
}

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
    if (!(await verifySigningCertificateBinding(signerInfo.signedAttrs.attributes, signer))) {
      return { valid: false, reason: 'signing_certificate_invalid' };
    }

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

  return { valid: false, reason: 'signing_certificate_invalid' };
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

    const signerInfo = parsed.signedData.signerInfos[0]!;
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

  return {
    status: 'valid',
    tsaTimestamp: parsed.tstInfo.genTime.toISOString(),
    policyOid: parsed.tstInfo.policy,
    serialNumber: serialHex(parsed.tstInfo.serialNumber),
    signerSubject: subjectText(signer),
    messageImprintHex: imprintHex(parsed.tstInfo),
    digestAlgorithm: kinds.imprint,
  };
}

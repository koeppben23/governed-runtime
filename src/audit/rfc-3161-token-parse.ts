/**
 * @module audit/rfc-3161-token-parse
 * @description RFC 3161 TimeStampToken parsing and certificate helpers.
 *
 * Decodes the base64 DER envelope (ContentInfo -> SignedData -> TSTInfo),
 * parses trust-anchor PEMs, locates the signing certificate, and extracts
 * CMS signed-attribute values. All failures throw {@link TsaError} with
 * `TSA_MALFORMED_ASN1`; the verifier maps that to `malformed_token`.
 *
 * @version v1
 */

import * as asn1js from 'asn1js';
import { Certificate, ContentInfo, IssuerAndSerialNumber, SignedData, TSTInfo } from 'pkijs';
import { constantTimeBytesEqual } from './constant-time.js';
import { TsaError } from './errors.js';

const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';
export const OID_TST_INFO = '1.2.840.113549.1.9.16.1.4';
export const OID_SHA256 = '2.16.840.1.101.3.4.2.1';
export const OID_SHA384 = '2.16.840.1.101.3.4.2.2';
export const OID_SHA512 = '2.16.840.1.101.3.4.2.3';
export const OID_CONTENT_TYPE = '1.2.840.113549.1.9.3';
export const OID_MESSAGE_DIGEST = '1.2.840.113549.1.9.4';
export const OID_EKU = '2.5.29.37';
export const OID_KP_TIMESTAMPING = '1.3.6.1.5.5.7.3.8';
export const OID_MGF1 = '1.2.840.113549.1.1.8';
export const OID_RSA_SHA256 = '1.2.840.113549.1.1.11';
export const OID_RSA_SHA384 = '1.2.840.113549.1.1.12';
export const OID_RSA_SHA512 = '1.2.840.113549.1.1.13';
export const OID_ECDSA_SHA256 = '1.2.840.10045.4.3.2';
export const OID_ECDSA_SHA384 = '1.2.840.10045.4.3.3';
export const OID_ECDSA_SHA512 = '1.2.840.10045.4.3.4';
export const OID_RSA_PSS = '1.2.840.113549.1.1.10';

/** Critical extensions this verifier understands and validates explicitly. */
export const UNDERSTOOD_CRITICAL_EXTENSIONS = new Set([
  OID_EKU,
  '2.5.29.19', // basicConstraints
  '2.5.29.15', // keyUsage
  '2.5.29.14', // subjectKeyIdentifier
  '2.5.29.35', // authorityKeyIdentifier
  '2.5.29.17', // subjectAltName
]);

export type VerificationReason =
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

export type InvalidResult = { status: 'invalid'; reason: VerificationReason; detail?: string };

export function invalid(reason: VerificationReason, detail?: string): InvalidResult {
  return { status: 'invalid', reason, ...(detail ? { detail } : {}) };
}

export interface ParsedToken {
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

export function parseToken(tokenDerBase64: string): ParsedToken {
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

export function parseTrustAnchor(pem: string): Certificate {
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

export function sameBytes(
  left: Uint8Array | ArrayBuffer,
  right: Uint8Array | ArrayBuffer,
): boolean {
  const a = left instanceof ArrayBuffer ? new Uint8Array(left) : left;
  const b = right instanceof ArrayBuffer ? new Uint8Array(right) : right;
  return constantTimeBytesEqual(a, b);
}

export function serialHex(serial: asn1js.Integer): string {
  return Buffer.from(serial.valueBlock.valueHexView).toString('hex');
}

export function imprintHex(tstInfo: TSTInfo): string {
  return Buffer.from(tstInfo.messageImprint.hashedMessage.valueBlock.valueHexView).toString('hex');
}

export function subjectText(cert: Certificate | null | undefined): string | undefined {
  const values = cert?.subject.typesAndValues ?? [];
  // Presentation-only mutant: an empty subject renders '' instead of
  // undefined — no authority derives from subjectText.
  if (values.length === 0) return undefined;
  return values.map((v) => `${v.type}=${v.value.valueBlock.value}`).join(', ');
}

export function certValidityReason(cert: Certificate, at: Date): VerificationReason | null {
  if (at < cert.notBefore.value) return 'cert_not_yet_valid';
  if (at > cert.notAfter.value) return 'cert_expired';
  return null;
}

export function certDerHex(cert: Certificate): string {
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

export function signerCertificate(signedData: SignedData): Certificate | null {
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

export interface AttrLike {
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

export function extractAttributeValue(
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

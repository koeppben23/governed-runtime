/**
 * @module audit/rfc3161-pkijs-verifier
 * @description RFC 3161 TimeStampToken verification using pkijs/asn1js.
 *
 * Trust anchor model: this verifier supports end-entity certificate pinning only.
 * Each trust anchor PEM must contain the exact signing certificate — CA chain
 * validation is not performed. Verifying the signer certificate equals (DER
 * equality) one of the configured trust anchors serves as the binding check.
 */

import * as asn1js from 'asn1js';
import {
  Certificate,
  ContentInfo,
  IssuerAndSerialNumber,
  SignedData,
  TSTInfo,
  getCrypto,
} from 'pkijs';
import type { TimestampVerifier } from './tsa-provider.js';

const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';
const OID_TST_INFO = '1.2.840.113549.1.9.16.1.4';
const OID_SHA256 = '2.16.840.1.101.3.4.2.1';
const OID_CONTENT_TYPE = '1.2.840.113549.1.9.3';
const OID_MESSAGE_DIGEST = '1.2.840.113549.1.9.4';

type VerificationReason =
  | 'malformed_token'
  | 'digest_mismatch'
  | 'untrusted_cert'
  | 'cert_expired'
  | 'cert_not_yet_valid'
  | 'unsupported_algorithm'
  | 'signed_attrs_invalid'
  | 'missing_signer_info';

interface ParsedToken {
  readonly signedData: SignedData;
  readonly tstInfo: TSTInfo;
  readonly tstInfoDer: ArrayBuffer;
}

function invalid(reason: VerificationReason): { status: 'invalid'; reason: VerificationReason } {
  return { status: 'invalid', reason };
}

function decodeBase64Der(input: string): ArrayBuffer {
  try {
    const bytes = Buffer.from(input, 'base64');
    return new Uint8Array(bytes).buffer;
  } catch {
    throw new Error('invalid base64 DER');
  }
}

function parseDer(input: ArrayBuffer): asn1js.BaseBlock<asn1js.ValueBlock> {
  const parsed = asn1js.fromBER(input);
  if (parsed.offset === -1) throw new Error('invalid DER');
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
  if (contentInfo.contentType !== OID_SIGNED_DATA) throw new Error('not SignedData');

  const signedData = new SignedData({ schema: contentInfo.content });
  if (signedData.encapContentInfo.eContentType !== OID_TST_INFO) throw new Error('not TSTInfo');

  const eContent = signedData.encapContentInfo.eContent;
  if (!eContent) throw new Error('missing TSTInfo content');
  const contentDer = octetStringBytes(eContent);
  const tstInfo = new TSTInfo({ schema: parseDer(contentDer) });
  return { signedData, tstInfo, tstInfoDer: contentDer };
}

function parseTrustAnchor(pem: string): Certificate {
  const base64 = pem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
  if (!base64) throw new Error('empty trust anchor');
  return new Certificate({ schema: parseDer(decodeBase64Der(base64)) });
}

function sameBytes(left: Uint8Array | ArrayBuffer, right: Uint8Array | ArrayBuffer): boolean {
  const a = left instanceof ArrayBuffer ? new Uint8Array(left) : left;
  const b = right instanceof ArrayBuffer ? new Uint8Array(right) : right;
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function serialHex(serial: asn1js.Integer): string {
  return Buffer.from(serial.valueBlock.valueHexView).toString('hex');
}

function subjectText(cert: Certificate | null | undefined): string | undefined {
  const values = cert?.subject.typesAndValues ?? [];
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

function extractAttributeValue(
  attrs: ReadonlyArray<AttrLike>,
  oid: string,
): Uint8Array | undefined {
  for (const attr of attrs) {
    if (attr.type !== oid) continue;
    const first = attr.values[0];
    if (!first) continue;
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
    if (raw) return new Uint8Array(raw);
  }
  return undefined;
}

async function verifyCmsSignature(
  parsed: ParsedToken,
  signer: Certificate,
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

    const computedMd = await crypto.digest({ name: 'SHA-256' }, new Uint8Array(parsed.tstInfoDer));
    if (!sameBytes(computedMd, mdValue)) return { valid: false, reason: 'signed_attrs_invalid' };

    const signedAttrsDer = signerInfo.signedAttrs.toSchema().toBER();
    const view = new Uint8Array(signedAttrsDer);
    view[0] = 0x31;
    const sigOk = await crypto.verifyWithPublicKey(
      view.buffer,
      signerInfo.signature,
      signer.subjectPublicKeyInfo,
      signerInfo.signatureAlgorithm,
      'SHA-256',
    );
    return sigOk ? { valid: true } : { valid: false, reason: 'untrusted_cert' };
  }

  const sigOk = await crypto.verifyWithPublicKey(
    parsed.tstInfoDer,
    signerInfo.signature,
    signer.subjectPublicKeyInfo,
    signerInfo.signatureAlgorithm,
    'SHA-256',
  );
  return sigOk ? { valid: true } : { valid: false, reason: 'untrusted_cert' };
}

export class PkijsTimestampVerifier implements TimestampVerifier {
  async verifyToken(input: {
    tokenDerBase64: string;
    expectedDigest: Uint8Array;
    digestAlgorithm: 'sha256';
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

    const imprint = parsed.tstInfo.messageImprint;
    if (imprint.hashAlgorithm.algorithmId !== OID_SHA256 || input.digestAlgorithm !== 'sha256') {
      return invalid('unsupported_algorithm');
    }

    if (
      !sameBytes(
        new Uint8Array(imprint.hashedMessage.valueBlock.valueHexView).buffer,
        input.expectedDigest,
      )
    ) {
      return invalid('digest_mismatch');
    }

    if (trustAnchors.length === 0) return invalid('untrusted_cert');

    const signer = signerCertificate(parsed.signedData);
    if (!signer) return invalid('missing_signer_info');

    try {
      const sigResult = await verifyCmsSignature(parsed, signer);
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
    };
  }
}

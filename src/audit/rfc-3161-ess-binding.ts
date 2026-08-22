import * as asn1js from 'asn1js';
import { AlgorithmIdentifier, Certificate, getCrypto } from 'pkijs';
import type { TsDigestAlgorithm } from './canonical-digest.js';
import { constantTimeBytesEqual } from './constant-time.js';

const OID_SHA256 = '2.16.840.1.101.3.4.2.1';
const OID_SHA384 = '2.16.840.1.101.3.4.2.2';
const OID_SHA512 = '2.16.840.1.101.3.4.2.3';
const OID_SIGNING_CERTIFICATE = '1.2.840.113549.1.9.16.2.12';
const OID_SIGNING_CERTIFICATE_V2 = '1.2.840.113549.1.9.16.2.47';

interface AttrLike {
  readonly type: string;
  readonly values: ReadonlyArray<asn1js.BaseBlock<asn1js.ValueBlock>>;
}

interface SigningCertificateBinding {
  readonly hash: Uint8Array;
  readonly algorithm: TsDigestAlgorithm | 'sha1';
}

function digestKindFromOid(oid: string): TsDigestAlgorithm | null {
  if (oid === OID_SHA256) return 'sha256';
  if (oid === OID_SHA384) return 'sha384';
  if (oid === OID_SHA512) return 'sha512';
  return null;
}

function webcryptoHashName(kind: TsDigestAlgorithm): string {
  return kind === 'sha256' ? 'SHA-256' : kind === 'sha384' ? 'SHA-384' : 'SHA-512';
}

function sequenceValues(
  input: asn1js.BaseBlock<asn1js.ValueBlock> | undefined,
): asn1js.BaseBlock<asn1js.ValueBlock>[] | null {
  return input instanceof asn1js.Sequence ? input.valueBlock.value : null;
}

function signingCertificateEntries(attr: AttrLike): asn1js.BaseBlock<asn1js.ValueBlock>[] | null {
  if (attr.values.length !== 1) return null;
  const outer = sequenceValues(attr.values[0]);
  if (!outer || outer.length < 1 || outer.length > 2) return null;
  if (outer[1] && !(outer[1] instanceof asn1js.Sequence)) return null;
  const certs = sequenceValues(outer[0]);
  return certs?.length ? certs : null;
}

function bindingWithIssuerSerial(
  hash: asn1js.OctetString,
  algorithm: SigningCertificateBinding['algorithm'],
  issuerSerial: asn1js.BaseBlock<asn1js.ValueBlock> | undefined,
): SigningCertificateBinding | null {
  // This profile accepts only the hash-only ESS identifier form. A present
  // issuerSerial is signed input, so accept it only after full verification.
  if (issuerSerial) return null;
  return {
    hash: new Uint8Array(hash.valueBlock.valueHexView),
    algorithm,
  };
}

function signingCertificateHash(attr: AttrLike): SigningCertificateBinding | null {
  const certs = signingCertificateEntries(attr);
  const fields = certs && sequenceValues(certs[0]);
  if (!fields || fields.length < 1 || fields.length > 2) return null;
  const [hash, issuerSerial] = fields;
  return hash instanceof asn1js.OctetString
    ? bindingWithIssuerSerial(hash, 'sha1', issuerSerial)
    : null;
}

function defaultV2Binding(
  fields: asn1js.BaseBlock<asn1js.ValueBlock>[],
): SigningCertificateBinding | null {
  if (fields.length < 1 || fields.length > 2) return null;
  const [hash, issuerSerial] = fields;
  return hash instanceof asn1js.OctetString
    ? bindingWithIssuerSerial(hash, 'sha256', issuerSerial)
    : null;
}

function explicitV2Binding(
  fields: asn1js.BaseBlock<asn1js.ValueBlock>[],
): SigningCertificateBinding | null {
  if (fields.length < 2 || fields.length > 3) return null;
  const [algorithmSchema, hash, issuerSerial] = fields;
  if (!(algorithmSchema instanceof asn1js.Sequence) || !(hash instanceof asn1js.OctetString)) {
    return null;
  }
  try {
    const algorithm = new AlgorithmIdentifier({ schema: algorithmSchema });
    const kind = digestKindFromOid(algorithm.algorithmId);
    return kind ? bindingWithIssuerSerial(hash, kind, issuerSerial) : null;
  } catch {
    return null;
  }
}

function signingCertificateV2Hash(attr: AttrLike): SigningCertificateBinding | null {
  const certs = signingCertificateEntries(attr);
  const fields = certs && sequenceValues(certs[0]);
  if (!fields) return null;
  return fields[0] instanceof asn1js.OctetString
    ? defaultV2Binding(fields)
    : explicitV2Binding(fields);
}

export async function verifySigningCertificateBinding(
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

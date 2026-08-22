import * as asn1js from 'asn1js';
import {
  Accuracy,
  AlgorithmIdentifier,
  Attribute,
  AttributeTypeAndValue,
  BasicConstraints,
  Certificate,
  ContentInfo,
  EncapsulatedContentInfo,
  Extension,
  IssuerAndSerialNumber,
  MessageImprint,
  PKIStatus,
  PKIStatusInfo,
  SignedAndUnsignedAttributes,
  SignedData,
  SignerInfo,
  TSTInfo,
  TimeStampResp,
  getAlgorithmParameters,
  getCrypto,
} from 'pkijs';

export const RFC3161_TEST_DIGEST = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));
export const RFC3161_TEST_POLICY_OID = '1.3.6.1.4.1.4146.1.95';

let nextSerial = 1000;

function wrapContentInfo(signedData: SignedData): string {
  const content = new ContentInfo({
    contentType: ContentInfo.SIGNED_DATA,
    content: signedData.toSchema(true),
  });
  const cms = new ContentInfo({ schema: content.toSchema() });
  return Buffer.from(cms.toSchema().toBER(false)).toString('base64');
}

export interface Rfc3161Fixture {
  readonly tokenDerBase64: string;
  readonly trustAnchorPem: string;
  readonly untrustedAnchorPem: string;
}

export interface Rfc3161FixtureAuthority {
  readonly trustAnchorPem: string;
  issue(input?: {
    readonly digest?: Uint8Array;
    readonly digestOid?: string;
    readonly genTime?: Date;
  }): Promise<{ tokenDerBase64: string }>;
}

function derToPem(label: string, der: ArrayBuffer): string {
  const base64 = Buffer.from(der).toString('base64');
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

const OID_EKU = '2.5.29.37';
const OID_KP_TIMESTAMPING = '1.3.6.1.5.5.7.3.8';
const OID_KP_CLIENT_AUTH = '1.3.6.1.5.5.7.3.2';

export type FixtureEkuVariant = 'timestamping' | 'none' | 'extra' | 'non_critical';

async function makeCertificate(input: {
  readonly commonName: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly eku?: FixtureEkuVariant;
  readonly unknownCriticalExtension?: boolean;
  readonly keyScheme?: 'pkcs1' | 'pss';
  readonly keyHash?: 'SHA-256' | 'SHA-384' | 'SHA-512';
}): Promise<{ cert: Certificate; privateKey: CryptoKey; pem: string }> {
  const crypto = getCrypto(true);
  const cert = new Certificate();
  cert.version = 2;
  cert.serialNumber = new asn1js.Integer({ value: nextSerial++ });
  cert.issuer.typesAndValues.push(
    new AttributeTypeAndValue({
      type: '2.5.4.3',
      value: new asn1js.BmpString({ value: input.commonName }),
    }),
  );
  cert.subject.typesAndValues.push(
    new AttributeTypeAndValue({
      type: '2.5.4.3',
      value: new asn1js.BmpString({ value: input.commonName }),
    }),
  );
  cert.notBefore.value = input.notBefore;
  cert.notAfter.value = input.notAfter;
  const extensions: Extension[] = [
    new Extension({
      extnID: '2.5.29.19',
      critical: false,
      extnValue: new BasicConstraints({ cA: true }).toSchema().toBER(false),
    }),
    new Extension({
      extnID: '2.5.29.15',
      critical: false,
      extnValue: new asn1js.BitString({ valueHex: new Uint8Array([0x86]).buffer }).toBER(false),
    }),
  ];
  const ekuVariant = input.eku ?? 'timestamping';
  if (ekuVariant !== 'none') {
    const purposes =
      ekuVariant === 'extra' ? [OID_KP_TIMESTAMPING, OID_KP_CLIENT_AUTH] : [OID_KP_TIMESTAMPING];
    extensions.push(
      new Extension({
        extnID: OID_EKU,
        critical: ekuVariant !== 'non_critical',
        extnValue: new asn1js.Sequence({
          value: purposes.map((oid) => new asn1js.ObjectIdentifier({ value: oid })),
        }).toBER(false),
      }),
    );
  }
  if (input.unknownCriticalExtension) {
    extensions.push(
      new Extension({
        extnID: '1.3.6.1.4.1.99999.1',
        critical: true,
        extnValue: new asn1js.OctetString({ valueHex: new Uint8Array([0x05, 0x00]).buffer }).toBER(
          false,
        ),
      }),
    );
  }
  cert.extensions = extensions;

  const keyScheme = input.keyScheme ?? 'pkcs1';
  const keyHash = input.keyHash ?? 'SHA-256';
  const algorithm = getAlgorithmParameters(
    keyScheme === 'pss' ? 'RSA-PSS' : 'RSASSA-PKCS1-v1_5',
    'generateKey',
  );
  const keyAlgorithm = algorithm.algorithm as RsaHashedKeyGenParams;
  keyAlgorithm.hash = { name: keyHash };
  if (keyScheme === 'pss') {
    (keyAlgorithm as unknown as RsaPssParams).saltLength = 32;
  }
  const keys = await crypto.generateKey(keyAlgorithm, true, algorithm.usages);
  await cert.subjectPublicKeyInfo.importKey(keys.publicKey);
  await cert.sign(keys.privateKey, keyHash);

  return {
    cert,
    privateKey: keys.privateKey,
    pem: derToPem('CERTIFICATE', cert.toSchema().toBER(false)),
  };
}

export async function makeRfc3161Fixture(
  input: {
    readonly digest?: Uint8Array;
    readonly digestOid?: string;
    readonly notBefore?: Date;
    readonly notAfter?: Date;
    readonly genTime?: Date;
    readonly eku?: FixtureEkuVariant;
    readonly unknownCriticalExtension?: boolean;
    readonly keyScheme?: 'pkcs1' | 'pss';
  } = {},
): Promise<Rfc3161Fixture> {
  const signer = await makeCertificate({
    commonName: 'FlowGuard Test TSA',
    notBefore: input.notBefore ?? new Date('2025-01-01T00:00:00.000Z'),
    notAfter: input.notAfter ?? new Date('2027-01-01T00:00:00.000Z'),
    eku: input.eku,
    unknownCriticalExtension: input.unknownCriticalExtension,
    keyScheme: input.keyScheme,
    keyHash: webcryptoHashNameForOid(input.digestOid ?? '2.16.840.1.101.3.4.2.1') as
      'SHA-256' | 'SHA-384' | 'SHA-512',
  });
  const untrusted = await makeCertificate({
    commonName: 'Untrusted TSA',
    notBefore: new Date('2025-01-01T00:00:00.000Z'),
    notAfter: new Date('2027-01-01T00:00:00.000Z'),
  });
  const issued = await issueToken(signer, input);

  return {
    tokenDerBase64: issued.tokenDerBase64,
    trustAnchorPem: signer.pem,
    untrustedAnchorPem: untrusted.pem,
  };
}

export async function makeRfc3161FixtureAuthority(
  input: {
    readonly notBefore?: Date;
    readonly notAfter?: Date;
  } = {},
): Promise<Rfc3161FixtureAuthority> {
  const signer = await makeCertificate({
    commonName: 'FlowGuard Test TSA',
    notBefore: input.notBefore ?? new Date('2025-01-01T00:00:00.000Z'),
    notAfter: input.notAfter ?? new Date('2027-01-01T00:00:00.000Z'),
  });
  return {
    trustAnchorPem: signer.pem,
    issue: async (issueInput = {}) => issueToken(signer, issueInput),
  };
}

async function issueToken(
  signer: { cert: Certificate; privateKey: CryptoKey },
  input: {
    readonly digest?: Uint8Array;
    readonly digestOid?: string;
    readonly genTime?: Date;
  } = {},
): Promise<{ tokenDerBase64: string }> {
  const genTime = input.genTime ?? new Date('2026-01-01T00:00:00.000Z');
  const digestOid = input.digestOid ?? '2.16.840.1.101.3.4.2.1';
  const tstInfo = new TSTInfo({
    version: 1,
    policy: RFC3161_TEST_POLICY_OID,
    messageImprint: new MessageImprint({
      hashAlgorithm: new AlgorithmIdentifier({
        algorithmId: digestOid,
      }),
      hashedMessage: new asn1js.OctetString({
        valueHex: new Uint8Array(input.digest ?? RFC3161_TEST_DIGEST).buffer,
      }),
    }),
    serialNumber: new asn1js.Integer({ value: 42 }),
    genTime,
    ordering: true,
    accuracy: new Accuracy({ seconds: 1 }),
  });
  const tstBer = tstInfo.toSchema().toBER(false);
  const signedData = new SignedData({
    version: 3,
    encapContentInfo: new EncapsulatedContentInfo({
      eContentType: '1.2.840.113549.1.9.16.1.4',
      eContent: new asn1js.OctetString({ valueHex: tstBer }),
    }),
    signerInfos: [
      new SignerInfo({
        version: 1,
        sid: new IssuerAndSerialNumber({
          issuer: signer.cert.issuer,
          serialNumber: signer.cert.serialNumber,
        }),
      }),
    ],
    certificates: [signer.cert],
  });
  // The signer digest follows the message-imprint algorithm (RFC 3161 §2.4.2).
  await signedData.sign(signer.privateKey, 0, webcryptoHashNameForOid(digestOid));
  const cmsContent = new ContentInfo({
    contentType: ContentInfo.SIGNED_DATA,
    content: signedData.toSchema(true),
  });
  const response = new TimeStampResp({
    status: new PKIStatusInfo({ status: PKIStatus.granted }),
    timeStampToken: new ContentInfo({ schema: cmsContent.toSchema() }),
  });

  return {
    tokenDerBase64: Buffer.from(response.timeStampToken!.toSchema().toBER(false)).toString(
      'base64',
    ),
  };
}

function webcryptoHashNameForOid(oid: string): string {
  if (oid === '2.16.840.1.101.3.4.2.2') return 'SHA-384';
  if (oid === '2.16.840.1.101.3.4.2.3') return 'SHA-512';
  return 'SHA-256';
}

const OID_TST_INFO = '1.2.840.113549.1.9.16.1.4';
const OID_CONTENT_TYPE = '1.2.840.113549.1.9.3';
const OID_MESSAGE_DIGEST = '1.2.840.113549.1.9.4';
const OID_SHA256 = '2.16.840.1.101.3.4.2.1';

function asn1Oid(value: string): asn1js.ObjectIdentifier {
  return new asn1js.ObjectIdentifier({ value });
}

export type TamperedTokenKind =
  | 'tampered_signature'
  | 'tampered_tst_info'
  | 'digest_mismatch_in_signed_attrs'
  | 'wrong_content_type_in_signed_attrs'
  | 'wrong_econtent_type'
  | 'wrong_cms_content_type'
  | 'no_signer_info'
  | 'no_certificate'
  | 'wrong_signer_sid'
  | 'signer_digest_divergence'
  | 'tampered_signature_algorithm'
  | 'tampered_signature_algorithm_sha384'
  | 'tampered_pss_params';

async function makeCertificateQuick(
  commonName: string,
): Promise<{ cert: Certificate; privateKey: CryptoKey; pem: string }> {
  return makeCertificate({
    commonName,
    notBefore: new Date('2025-01-01T00:00:00.000Z'),
    notAfter: new Date('2027-01-01T00:00:00.000Z'),
  });
}

async function buildTstInfoDer(
  input: { digestOid?: string; genTime?: Date } = {},
): Promise<ArrayBuffer> {
  return new TSTInfo({
    version: 1,
    policy: RFC3161_TEST_POLICY_OID,
    messageImprint: new MessageImprint({
      hashAlgorithm: new AlgorithmIdentifier({ algorithmId: input.digestOid ?? OID_SHA256 }),
      hashedMessage: new asn1js.OctetString({
        valueHex: new Uint8Array(RFC3161_TEST_DIGEST).buffer,
      }),
    }),
    serialNumber: new asn1js.Integer({ value: 42 }),
    genTime: input.genTime ?? new Date('2026-01-01T00:00:00.000Z'),
    ordering: true,
    accuracy: new Accuracy({ seconds: 1 }),
  })
    .toSchema()
    .toBER(false);
}

export async function makeRfc3161TamperedFixture(
  kind: TamperedTokenKind,
): Promise<{ tokenDerBase64: string; trustAnchorPem: string }> {
  const signer = await makeCertificateQuick('FlowGuard Test TSA');
  const tstInfoDer = await buildTstInfoDer(
    kind === 'signer_digest_divergence' ? { digestOid: '2.16.840.1.101.3.4.2.2' } : {},
  );
  const signedAttrsAttr = await buildTamperedSignedAttributes(kind, tstInfoDer);
  const signedData = buildTamperedSignedData(kind, signer.cert, tstInfoDer, signedAttrsAttr);

  if (signedAttrsAttr) await signedData.sign(signer.privateKey, 0, 'SHA-256');
  await applyTamperedTokenKind(kind, signedData, signer.cert);

  if (kind === 'wrong_cms_content_type') {
    const dataContent = new ContentInfo({
      contentType: '1.2.840.113549.1.7.1',
      content: new asn1js.OctetString({ valueHex: new Uint8Array([0x05, 0x00]).buffer }),
    });
    return {
      tokenDerBase64: Buffer.from(dataContent.toSchema().toBER(false)).toString('base64'),
      trustAnchorPem: signer.pem,
    };
  }

  return {
    tokenDerBase64: wrapContentInfo(signedData),
    trustAnchorPem: signer.pem,
  };
}

async function buildTamperedSignedAttributes(
  kind: TamperedTokenKind,
  tstInfoDer: ArrayBuffer,
): Promise<SignedAndUnsignedAttributes | undefined> {
  if (kind === 'no_signer_info') return undefined;
  const engine = getCrypto(true);
  const digest = await engine.digest({ name: 'SHA-256' }, new Uint8Array(tstInfoDer));
  const contentType =
    kind === 'wrong_content_type_in_signed_attrs' ? '1.2.840.113549.1.7.2' : OID_TST_INFO;
  const messageDigest = kind === 'digest_mismatch_in_signed_attrs' ? wrongDigestBuffer() : digest;
  return new SignedAndUnsignedAttributes({
    type: 0,
    attributes: [
      new Attribute({ type: OID_CONTENT_TYPE, values: [asn1Oid(contentType)] }),
      new Attribute({
        type: OID_MESSAGE_DIGEST,
        values: [new asn1js.OctetString({ valueHex: messageDigest })],
      }),
    ],
  });
}

function wrongDigestBuffer(): ArrayBuffer {
  const wrongDigest = new Uint8Array(32);
  wrongDigest.fill(0xaa);
  return wrongDigest.buffer;
}

function buildTamperedSignedData(
  kind: TamperedTokenKind,
  cert: Certificate,
  tstInfoDer: ArrayBuffer,
  signedAttrsAttr: SignedAndUnsignedAttributes | undefined,
): SignedData {
  return new SignedData({
    version: 3,
    encapContentInfo: new EncapsulatedContentInfo({
      eContentType: kind === 'wrong_econtent_type' ? '1.2.840.113549.1.7.2' : OID_TST_INFO,
      eContent: new asn1js.OctetString({ valueHex: tstInfoDer }),
    }),
    signerInfos: signedAttrsAttr ? [buildSignerInfo(cert, signedAttrsAttr)] : [],
    certificates: kind === 'no_certificate' ? undefined : [cert],
  });
}

function buildSignerInfo(cert: Certificate, signedAttrs: SignedAndUnsignedAttributes): SignerInfo {
  return new SignerInfo({
    version: 1,
    sid: new IssuerAndSerialNumber({ issuer: cert.issuer, serialNumber: cert.serialNumber }),
    signedAttrs,
  });
}

async function applyTamperedTokenKind(
  kind: TamperedTokenKind,
  signedData: SignedData,
  signerCert: Certificate,
): Promise<void> {
  if (kind === 'tampered_signature') tamperSignature(signedData);
  if (kind === 'tampered_tst_info') await tamperTstInfo(signedData);
  if (kind === 'wrong_signer_sid') tamperSignerSid(signedData, signerCert);
  if (kind === 'tampered_signature_algorithm') tamperSignatureAlgorithm(signedData);
  if (kind === 'tampered_signature_algorithm_sha384') tamperSignatureAlgorithmToSha384(signedData);
  if (kind === 'tampered_pss_params') tamperPssParams(signedData);
}

function tamperSignature(signedData: SignedData): void {
  const si = signedData.signerInfos[0];
  const sigHex = si?.signature?.valueBlock?.valueHexView;
  if (!si || !sigHex) return;
  const tampered = new Uint8Array(sigHex);
  tampered[tampered.length - 1]! ^= 0xff;
  si.signature.valueBlock.valueHex = tampered.buffer;
}

function tamperSignatureAlgorithm(signedData: SignedData): void {
  const si = signedData.signerInfos[0];
  if (!si) return;
  // md5WithRSAEncryption — outside the allowlist (TSA2).
  si.signatureAlgorithm = new AlgorithmIdentifier({ algorithmId: '1.2.840.113549.1.1.4' });
}

function tamperSignatureAlgorithmToSha384(signedData: SignedData): void {
  const si = signedData.signerInfos[0];
  if (!si) return;
  // sha384WithRSAEncryption — listed, but its hash no longer matches the
  // SHA-256 message imprint (TSA2 signature-hash coherence).
  si.signatureAlgorithm = new AlgorithmIdentifier({ algorithmId: '1.2.840.113549.1.1.12' });
}

function tamperPssParams(signedData: SignedData): void {
  const si = signedData.signerInfos[0];
  if (!si) return;
  // RSASSA-PSS with unparseable parameters — outside the validated contract.
  si.signatureAlgorithm = new AlgorithmIdentifier({
    algorithmId: '1.2.840.113549.1.1.10',
    algorithmParams: new asn1js.Sequence({ value: [asn1Oid('1.2.840.113549.1.1.8')] }),
  });
}

async function tamperTstInfo(signedData: SignedData): Promise<void> {
  signedData.encapContentInfo.eContent = new asn1js.OctetString({
    valueHex: await buildTstInfoDer({ genTime: new Date('2026-01-01T00:00:01.000Z') }),
  });
}

function tamperSignerSid(signedData: SignedData, signerCert: Certificate): void {
  const si = signedData.signerInfos[0];
  if (!si) return;
  si.sid = new IssuerAndSerialNumber({
    issuer: signerCert.issuer,
    serialNumber: new asn1js.Integer({ value: 999999 }),
  }).toSchema();
}

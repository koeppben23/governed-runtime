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

async function makeCertificate(input: {
  readonly commonName: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
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
  cert.extensions = [
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

  const algorithm = getAlgorithmParameters('RSASSA-PKCS1-v1_5', 'generateKey');
  const keyAlgorithm = algorithm.algorithm as RsaHashedKeyGenParams;
  keyAlgorithm.hash = { name: 'SHA-256' };
  const keys = await crypto.generateKey(keyAlgorithm, true, algorithm.usages);
  await cert.subjectPublicKeyInfo.importKey(keys.publicKey);
  await cert.sign(keys.privateKey, 'SHA-256');

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
  } = {},
): Promise<Rfc3161Fixture> {
  const signer = await makeCertificate({
    commonName: 'FlowGuard Test TSA',
    notBefore: input.notBefore ?? new Date('2025-01-01T00:00:00.000Z'),
    notAfter: input.notAfter ?? new Date('2027-01-01T00:00:00.000Z'),
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
  const tstInfo = new TSTInfo({
    version: 1,
    policy: RFC3161_TEST_POLICY_OID,
    messageImprint: new MessageImprint({
      hashAlgorithm: new AlgorithmIdentifier({
        algorithmId: input.digestOid ?? '2.16.840.1.101.3.4.2.1',
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
  await signedData.sign(signer.privateKey, 0, 'SHA-256');
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
  | 'no_signer_info'
  | 'no_certificate'
  | 'wrong_signer_sid';

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
  const tstInfoDer = await buildTstInfoDer();

  let signedAttrsAttr: SignedAndUnsignedAttributes | undefined;
  if (kind !== 'no_signer_info') {
    const engine = getCrypto(true);
    const digest = await engine.digest({ name: 'SHA-256' }, new Uint8Array(tstInfoDer));

    if (kind === 'wrong_content_type_in_signed_attrs') {
      signedAttrsAttr = new SignedAndUnsignedAttributes({
        type: 0,
        attributes: [
          new Attribute({
            type: OID_CONTENT_TYPE,
            values: [asn1Oid('1.2.840.113549.1.7.2')],
          }),
          new Attribute({
            type: OID_MESSAGE_DIGEST,
            values: [new asn1js.OctetString({ valueHex: digest })],
          }),
        ],
      });
    } else if (kind === 'digest_mismatch_in_signed_attrs') {
      const wrongDigest = new Uint8Array(32);
      wrongDigest.fill(0xaa);
      signedAttrsAttr = new SignedAndUnsignedAttributes({
        type: 0,
        attributes: [
          new Attribute({
            type: OID_CONTENT_TYPE,
            values: [asn1Oid(OID_TST_INFO)],
          }),
          new Attribute({
            type: OID_MESSAGE_DIGEST,
            values: [new asn1js.OctetString({ valueHex: wrongDigest.buffer })],
          }),
        ],
      });
    } else {
      signedAttrsAttr = new SignedAndUnsignedAttributes({
        type: 0,
        attributes: [
          new Attribute({
            type: OID_CONTENT_TYPE,
            values: [asn1Oid(OID_TST_INFO)],
          }),
          new Attribute({
            type: OID_MESSAGE_DIGEST,
            values: [new asn1js.OctetString({ valueHex: digest })],
          }),
        ],
      });
    }
  }

  const signedData = new SignedData({
    version: 3,
    encapContentInfo: new EncapsulatedContentInfo({
      eContentType: kind === 'wrong_econtent_type' ? '1.2.840.113549.1.7.2' : OID_TST_INFO,
      eContent: new asn1js.OctetString({ valueHex: tstInfoDer }),
    }),
    signerInfos: signedAttrsAttr
      ? [
          new SignerInfo({
            version: 1,
            sid: new IssuerAndSerialNumber({
              issuer: signer.cert.issuer,
              serialNumber: signer.cert.serialNumber,
            }),
            signedAttrs: signedAttrsAttr,
          }),
        ]
      : [],
    certificates: kind === 'no_certificate' ? undefined : [signer.cert],
  });

  if (signedAttrsAttr) {
    await signedData.sign(signer.privateKey, 0, 'SHA-256');
  }

  if (kind === 'tampered_signature') {
    const si = signedData.signerInfos[0];
    const sigHex = si?.signature?.valueBlock?.valueHexView;
    if (si && sigHex) {
      const tampered = new Uint8Array(sigHex);
      tampered[tampered.length - 1]! ^= 0xff;
      si.signature.valueBlock.valueHex = tampered.buffer;
    }
  }

  if (kind === 'tampered_tst_info') {
    signedData.encapContentInfo.eContent = new asn1js.OctetString({
      valueHex: await buildTstInfoDer({ genTime: new Date('2026-01-01T00:00:01.000Z') }),
    });
  }

  if (kind === 'wrong_signer_sid') {
    const si = signedData.signerInfos[0];
    if (si) {
      si.sid = new IssuerAndSerialNumber({
        issuer: signer.cert.issuer,
        serialNumber: new asn1js.Integer({ value: 999999 }),
      }).toSchema();
    }
  }

  return {
    tokenDerBase64: wrapContentInfo(signedData),
    trustAnchorPem: signer.pem,
  };
}

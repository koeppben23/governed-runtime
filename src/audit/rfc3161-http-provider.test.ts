import { describe, expect, it, vi } from 'vitest';
import * as asn1js from 'asn1js';
import { ContentInfo, PKIStatus, PKIStatusInfo, TimeStampReq, TimeStampResp } from 'pkijs';
import { HttpTimestampAuthorityProvider } from './rfc3161-http-provider.js';

const DIGEST = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));

function makeResponse(status = PKIStatus.granted): ArrayBuffer {
  if (status !== PKIStatus.granted) {
    return new asn1js.Sequence({
      value: [new asn1js.Sequence({ value: [new asn1js.Integer({ value: status })] })],
    }).toBER(false);
  }
  const token = new ContentInfo({
    contentType: ContentInfo.SIGNED_DATA,
    content: new asn1js.Sequence(),
  });
  return new TimeStampResp({
    status: new PKIStatusInfo({ status }),
    timeStampToken: token,
  })
    .toSchema()
    .toBER(false);
}

describe('HttpTimestampAuthorityProvider', () => {
  it('posts RFC3161 TimeStampReq and returns TimeStampToken DER base64', async () => {
    let requestBody: ArrayBuffer | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      requestBody = init?.body as ArrayBuffer;
      return new Response(makeResponse(), { status: 200 });
    });
    const provider = new HttpTimestampAuthorityProvider({ fetchImpl });

    const result = await provider.requestTimestamp({
      digest: DIGEST,
      digestAlgorithm: 'sha256',
      tsaUrl: 'https://tsa.example.test',
      timeoutMs: 1000,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://tsa.example.test',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/timestamp-query' }),
      }),
    );
    expect(result.tokenDerBase64).toMatch(/^[A-Za-z0-9+/]+=*$/);
    const parsed = asn1js.fromBER(requestBody!);
    const request = new TimeStampReq({ schema: parsed.result });
    expect(request.certReq).toBe(true);
    expect(Buffer.from(request.messageImprint.hashedMessage.valueBlock.valueHexView)).toEqual(
      Buffer.from(DIGEST),
    );
  });

  it('fails explicitly when TSA URL is missing', async () => {
    const provider = new HttpTimestampAuthorityProvider({ fetchImpl: vi.fn() as typeof fetch });

    await expect(
      provider.requestTimestamp({
        digest: DIGEST,
        digestAlgorithm: 'sha256',
        tsaUrl: '',
        timeoutMs: 1000,
      }),
    ).rejects.toThrow('TSA URL is required');
  });

  it('fails explicitly for non-2xx TSA response', async () => {
    const provider = new HttpTimestampAuthorityProvider({
      fetchImpl: vi.fn(async () => new Response('denied', { status: 503 })) as typeof fetch,
    });

    await expect(
      provider.requestTimestamp({
        digest: DIGEST,
        digestAlgorithm: 'sha256',
        tsaUrl: 'https://tsa.example.test',
        timeoutMs: 1000,
      }),
    ).rejects.toThrow('HTTP 503');
  });

  it('fails explicitly for malformed ASN.1 response', async () => {
    const provider = new HttpTimestampAuthorityProvider({
      fetchImpl: vi.fn(
        async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
      ) as typeof fetch,
    });

    await expect(
      provider.requestTimestamp({
        digest: DIGEST,
        digestAlgorithm: 'sha256',
        tsaUrl: 'https://tsa.example.test',
        timeoutMs: 1000,
      }),
    ).rejects.toThrow('malformed ASN.1');
  });

  it('fails explicitly when TSA rejects the request', async () => {
    const provider = new HttpTimestampAuthorityProvider({
      fetchImpl: vi.fn(
        async () => new Response(makeResponse(PKIStatus.rejection), { status: 200 }),
      ) as typeof fetch,
    });

    await expect(
      provider.requestTimestamp({
        digest: DIGEST,
        digestAlgorithm: 'sha256',
        tsaUrl: 'https://tsa.example.test',
        timeoutMs: 1000,
      }),
    ).rejects.toThrow('rejected');
  });
});

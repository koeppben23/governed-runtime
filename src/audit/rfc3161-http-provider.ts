/**
 * @module audit/rfc3161-http-provider
 * @description RFC 3161 HTTP Timestamp Authority provider.
 */

import * as asn1js from 'asn1js';
import { AlgorithmIdentifier, MessageImprint, TimeStampReq, TimeStampResp, PKIStatus } from 'pkijs';
import type { TimestampAuthorityProvider } from './tsa-provider.js';

type FetchLike = typeof fetch;

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  return new Uint8Array(view).buffer;
}

function derToBase64(der: ArrayBuffer): string {
  return Buffer.from(der).toString('base64');
}

function parseTimeStampResp(der: ArrayBuffer): TimeStampResp {
  const parsed = asn1js.fromBER(der);
  if (parsed.offset === -1) throw new Error('TSA response is malformed ASN.1');
  return new TimeStampResp({ schema: parsed.result });
}

export class HttpTimestampAuthorityProvider implements TimestampAuthorityProvider {
  private readonly fetchImpl: FetchLike;

  constructor(opts?: { fetchImpl?: FetchLike }) {
    this.fetchImpl = opts?.fetchImpl ?? fetch;
  }

  async requestTimestamp(input: {
    digest: Uint8Array;
    digestAlgorithm: 'sha256';
    tsaUrl: string;
    timeoutMs: number;
  }): Promise<{ tokenDerBase64: string; receivedAt: string }> {
    if (!input.tsaUrl.trim()) throw new Error('TSA URL is required');
    if (input.digestAlgorithm !== 'sha256') throw new Error('Unsupported TSA digest algorithm');

    const request = new TimeStampReq({
      version: 1,
      messageImprint: new MessageImprint({
        hashAlgorithm: new AlgorithmIdentifier({ algorithmId: '2.16.840.1.101.3.4.2.1' }),
        hashedMessage: new asn1js.OctetString({ valueHex: toArrayBuffer(input.digest) }),
      }),
      certReq: true,
    });
    const body = request.toSchema().toBER(false);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs);

    try {
      const response = await this.fetchImpl(input.tsaUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/timestamp-query',
          Accept: 'application/timestamp-reply',
        },
        body,
        signal: controller.signal,
      });

      if (!response.ok) throw new Error(`TSA request failed with HTTP ${response.status}`);

      const der = await response.arrayBuffer();
      if (der.byteLength === 0) throw new Error('TSA response is empty');
      const timestampResponse = parseTimeStampResp(der);
      if (timestampResponse.status.status !== PKIStatus.granted) {
        throw new Error(`TSA request was rejected with status ${timestampResponse.status.status}`);
      }
      if (!timestampResponse.timeStampToken) throw new Error('TSA response missing TimeStampToken');

      return {
        tokenDerBase64: derToBase64(timestampResponse.timeStampToken.toSchema().toBER(false)),
        receivedAt: new Date().toISOString(),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

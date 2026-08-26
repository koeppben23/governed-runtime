/**
 * @module rails/review-url
 * @description Safe external-URL review sourcing: SSRF-mitigating validation,
 *              resolved-target checks, and UTF-8-strict content fetch.
 *
 * Extracted from review.ts along the URL-safety boundary. The review rail
 * re-exports the public surface, so callers keep one import path.
 *
 * @version v1
 */

import { request } from 'node:https';
import type { RequestOptions } from 'node:https';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { IncomingMessage } from 'node:http';
import { blocked } from '../config/reasons.js';
import type { RailBlocked } from './types.js';
import { lookupReviewHostname, type ReviewDnsLookup } from '../adapters/dns-resolution.js';
import {
  parseIPv4,
  isPrivateIPv4,
  isPrivateIPv6,
  isIPv4Address,
  isIPv6Address,
} from '../adapters/ip-validation.js';

/** Maximum decoded response body accepted as external review material. */
export const MAX_REVIEW_URL_RESPONSE_BYTES = 1_048_576;

export interface ResolvedReviewTarget {
  readonly hostname: string;
  readonly port: number;
  readonly address: string;
  readonly family: 4 | 6;
}

export type ReviewHttpsTransport = (
  url: string,
  target: ResolvedReviewTarget,
) => Promise<IncomingMessage>;

class ReviewContentEncodingError extends Error {
  readonly code = 'REVIEW_URL_CONTENT_ENCODING_INVALID';
}

// ─── URL Validation (BUG-13: SSRF Mitigation) ───────────────────────

/**
 * Validate a URL for safe external fetch. Fail-closed: any parsing
 * failure or disallowed target results in rejection.
 *
 * Rules:
 * - Scheme must be `https:` (no http, file, ftp, data, etc.)
 * - Hostname must not resolve to private/reserved IP ranges
 * - Hostname must not be `localhost` or a bare IPv4/IPv6 loopback
 * - URL must parse successfully via `new URL()`
 *
 * @returns Object with `valid` flag and optional `reason` for rejection.
 */
export function validateReviewUrl(url: string): { valid: true } | { valid: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, reason: `URL parsing failed: ${url}` };
  }

  // Scheme allowlist: only HTTPS
  if (parsed.protocol !== 'https:') {
    return {
      valid: false,
      reason: `URL scheme '${parsed.protocol}' is not allowed; only https: is permitted`,
    };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block localhost (any casing)
  if (hostname === 'localhost') {
    return { valid: false, reason: 'URL hostname "localhost" is blocked (private network)' };
  }

  // Block bare IPv4 in private ranges
  // Hostname may be a bare IP or bracket-wrapped IPv6.
  const ipv4 = parseIPv4(hostname);
  if (ipv4 !== null) {
    if (isPrivateIPv4(ipv4)) {
      return {
        valid: false,
        reason: `URL hostname "${hostname}" resolves to a private/reserved IPv4 range`,
      };
    }
  }

  // Block bracket-wrapped IPv6 — URL parser keeps brackets in hostname.
  // e.g. new URL('https://[::1]/') → hostname = '[::1]'
  // Strip brackets before checking against private IPv6 prefixes.
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const bareIpv6 = hostname.slice(1, -1);
    if (isPrivateIPv6(bareIpv6)) {
      return {
        valid: false,
        reason: `URL hostname "${hostname}" resolves to a private/reserved IPv6 range`,
      };
    }
  } else if (hostname.includes(':')) {
    // Bare IPv6 without brackets (unusual but defensive)
    if (isPrivateIPv6(hostname)) {
      return {
        valid: false,
        reason: `URL hostname "${hostname}" resolves to a private/reserved IPv6 range`,
      };
    }
  }

  return { valid: true };
}

export async function validateResolvedReviewUrlTarget(
  url: string,
  dnsLookup: ReviewDnsLookup = lookupReviewHostname,
): Promise<{ valid: true } | { valid: false; reason: string }> {
  const target = await resolveReviewTarget(url, dnsLookup);
  return 'reason' in target ? { valid: false, reason: target.reason } : { valid: true };
}

/** Resolve and validate the one concrete network peer used by the HTTPS request. */
// The explicit branches preserve distinct fail-closed diagnostics for each boundary.
// eslint-disable-next-line complexity
export async function resolveReviewTarget(
  url: string,
  dnsLookup: ReviewDnsLookup = lookupReviewHostname,
): Promise<ResolvedReviewTarget | { reason: string }> {
  const syntax = validateReviewUrl(url);
  if (!syntax.valid) return { reason: syntax.reason };

  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase();
  const bareHostname =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

  const literal = parseIPv4(bareHostname);
  if (literal !== null) {
    return {
      hostname: bareHostname,
      port: parsed.port ? Number(parsed.port) : 443,
      address: bareHostname,
      family: 4,
    };
  }
  if (bareHostname.includes(':') && isLiteralAddressAllowed(bareHostname)) {
    return {
      hostname: bareHostname,
      port: parsed.port ? Number(parsed.port) : 443,
      address: bareHostname,
      family: 6,
    };
  }

  let addresses: readonly { readonly address: string; readonly family: 4 | 6 }[];
  try {
    addresses = await dnsLookup(bareHostname);
  } catch (err) {
    return {
      reason: `DNS lookup failed for "${hostname}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (addresses.length === 0) {
    return { reason: `DNS lookup for "${hostname}" returned no addresses` };
  }

  for (const resolved of addresses) {
    const validation = validateResolvedAddress(hostname, resolved.address, resolved.family);
    if (!validation.valid) return { reason: validation.reason };
  }

  const target = addresses[0]!;
  return {
    hostname: bareHostname,
    port: parsed.port ? Number(parsed.port) : 443,
    address: target.address,
    family: target.family,
  };
}

function isLiteralAddressAllowed(hostname: string): boolean {
  const ipv4 = parseIPv4(hostname);
  if (ipv4 !== null) return !isPrivateIPv4(ipv4);
  if (hostname.includes(':')) return !isPrivateIPv6(hostname);
  return false;
}

function validateResolvedAddress(
  hostname: string,
  address: string,
  family: 4 | 6,
): { valid: true } | { valid: false; reason: string } {
  if (family === 4) {
    if (!isIPv4Address(address)) {
      return {
        valid: false,
        reason: `DNS lookup for "${hostname}" returned malformed IPv4 address "${address}"`,
      };
    }
    const ipv4 = parseIPv4(address)!;
    if (isPrivateIPv4(ipv4)) {
      return {
        valid: false,
        reason: `DNS lookup for "${hostname}" returned private/reserved IPv4 address "${address}"`,
      };
    }
    return { valid: true };
  }

  if (!isIPv6Address(address)) {
    return {
      valid: false,
      reason: `DNS lookup for "${hostname}" returned malformed IPv6 address "${address}"`,
    };
  }
  if (isPrivateIPv6(address)) {
    return {
      valid: false,
      reason: `DNS lookup for "${hostname}" returned private/reserved IPv6 address "${address}"`,
    };
  }
  return { valid: true };
}

/** Fetch content through the validated target, with no connection-time DNS lookup. */
// The response boundary deliberately distinguishes transport, status, charset, and byte-limit failures.
// eslint-disable-next-line complexity
export async function fetchUrlContent(
  url: string,
  dnsLookup?: ReviewDnsLookup,
  transport: ReviewHttpsTransport = requestPinnedTarget,
): Promise<{ content: string } | RailBlocked> {
  const target = await resolveReviewTarget(url, dnsLookup);
  if ('reason' in target) {
    return blocked('COMMAND_BLOCKED', {
      command: '/review',
      reason: `URL validation blocked: ${target.reason}`,
    });
  }
  let response: IncomingMessage;
  try {
    response = await transport(url, target);
  } catch (err) {
    return blocked('COMMAND_BLOCKED', {
      command: '/review',
      reason: `Failed to fetch ${url}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
    return blocked('COMMAND_BLOCKED', {
      command: '/review',
      reason: `Failed to fetch ${url}: HTTP ${response.statusCode ?? 0} ${response.statusMessage ?? ''}`,
    });
  }
  const contentType = headerValue(response, 'content-type');
  if (!isUtf8ContentType(contentType)) {
    return blocked('REVIEW_URL_CONTENT_ENCODING_INVALID', {
      reason: `declared charset is not strict UTF-8 (${contentType ?? 'no charset declared'})`,
    });
  }
  try {
    return {
      content: new TextDecoder('utf-8', { fatal: true }).decode(
        await readDecodedResponseBodyWithinLimit(response, MAX_REVIEW_URL_RESPONSE_BYTES),
      ),
    };
  } catch (err) {
    if (err instanceof RangeError) {
      return blocked('COMMAND_BLOCKED', {
        command: '/review',
        reason: `Response exceeds the ${MAX_REVIEW_URL_RESPONSE_BYTES}-byte review material limit`,
      });
    }
    if (err instanceof ReviewContentEncodingError) {
      return blocked('REVIEW_URL_CONTENT_ENCODING_INVALID', { reason: err.message });
    }
    return blocked('REVIEW_URL_CONTENT_ENCODING_INVALID', {
      reason: 'response bytes are not valid UTF-8',
    });
  }
}

function requestPinnedTarget(url: string, target: ResolvedReviewTarget): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const options: RequestOptions & { autoSelectFamily: false } = {
      agent: false,
      family: target.family,
      autoSelectFamily: false,
      servername: target.hostname,
      headers: { 'accept-encoding': 'gzip, deflate, br' },
      lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
    };
    const req = request(url, options);
    req.setTimeout(15_000, () => req.destroy(new Error('HTTPS request timed out')));
    req.once('error', reject);
    req.once('socket', (socket) => {
      socket.once('secureConnect', () => {
        if (!sameIpAddress(socket.remoteAddress ?? '', target.address)) {
          req.destroy(new Error('HTTPS peer address differs from the validated target'));
        }
      });
    });
    req.once('response', resolve);
    req.end();
  });
}

async function readDecodedResponseBodyWithinLimit(
  response: IncomingMessage,
  maxBytes: number,
): Promise<Uint8Array> {
  const decoded = decodedStream(response, headerValue(response, 'content-encoding'));
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of decoded) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      total += bytes.byteLength;
      if (total > maxBytes) {
        decoded.destroy(new RangeError('response body exceeds review material limit'));
        throw new RangeError('response body exceeds review material limit');
      }
      chunks.push(bytes);
    }
  } finally {
    decoded.destroy();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function decodedStream(
  response: IncomingMessage,
  contentEncoding: string | null,
): IncomingMessage | ReturnType<typeof createGunzip> {
  const encoding = contentEncoding?.trim().toLowerCase() ?? 'identity';
  if (encoding === 'identity' || encoding === '') return response;
  const decoder =
    encoding === 'gzip'
      ? createGunzip()
      : encoding === 'deflate'
        ? createInflate()
        : encoding === 'br'
          ? createBrotliDecompress()
          : undefined;
  if (!decoder) throw new ReviewContentEncodingError(`unsupported Content-Encoding: ${encoding}`);
  response.pipe(decoder);
  return decoder;
}

function headerValue(response: IncomingMessage, name: string): string | null {
  const value = response.headers[name];
  return Array.isArray(value) ? value.join(', ') : (value ?? null);
}

function sameIpAddress(left: string, right: string): boolean {
  return normalizeIpAddress(left) === normalizeIpAddress(right);
}

function normalizeIpAddress(address: string): string {
  const lowered = address.toLowerCase();
  return lowered.startsWith('::ffff:') && parseIPv4(lowered.slice(7)) !== null
    ? lowered.slice(7)
    : lowered;
}

/** A declared charset is accepted only when it is unambiguously UTF-8. */
function isUtf8ContentType(contentType: string | null): boolean {
  if (contentType === null) return true;
  const charsetParameters = contentType
    .split(';')
    .slice(1)
    .map((parameter) => parameter.trim())
    .filter((parameter) => /^charset\s*=/i.test(parameter));
  return (
    charsetParameters.length <= 1 &&
    charsetParameters.every((parameter) => {
      const match = parameter.match(/^charset\s*=\s*(?:"([^"]*)"|([^\s;]+))$/i);
      const charset = match?.[1] ?? match?.[2];
      return charset?.toLowerCase() === 'utf-8';
    })
  );
}

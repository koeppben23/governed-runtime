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
  const syntax = validateReviewUrl(url);
  if (!syntax.valid) return syntax;

  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase();
  const bareHostname =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

  if (isLiteralAddressAllowed(bareHostname)) return { valid: true };

  let addresses: readonly { readonly address: string; readonly family: 4 | 6 }[];
  try {
    addresses = await dnsLookup(bareHostname);
  } catch (err) {
    return {
      valid: false,
      reason: `DNS lookup failed for "${hostname}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (addresses.length === 0) {
    return { valid: false, reason: `DNS lookup for "${hostname}" returned no addresses` };
  }

  for (const resolved of addresses) {
    const validation = validateResolvedAddress(hostname, resolved.address, resolved.family);
    if (!validation.valid) return validation;
  }

  return { valid: true };
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

/** Fetch content from URL using native fetch. Validates URL before fetching.
 *  Rejects private/reserved targets (SSRF mitigation).
 *  Disables redirect following to prevent SSRF via redirect.
 *  Returns a blocked result on validation failure or HTTP errors. */
export async function fetchUrlContent(
  url: string,
  dnsLookup?: ReviewDnsLookup,
): Promise<{ content: string } | RailBlocked> {
  const validation = await validateResolvedReviewUrlTarget(url, dnsLookup);
  if (!validation.valid) {
    return blocked('COMMAND_BLOCKED', {
      command: '/review',
      reason: `URL validation blocked: ${validation.reason}`,
    });
  }
  const resp = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!resp.ok) {
    return blocked('COMMAND_BLOCKED', {
      command: '/review',
      reason: `Failed to fetch ${url}: HTTP ${resp.status} ${resp.statusText}`,
    });
  }
  const contentType = resp.headers.get('content-type');
  if (!isUtf8ContentType(contentType)) {
    return blocked('REVIEW_URL_CONTENT_ENCODING_INVALID', {
      reason: `declared charset is not strict UTF-8 (${contentType ?? 'no charset declared'})`,
    });
  }
  try {
    const contentLength = resp.headers.get('content-length');
    if (contentLength !== null && Number(contentLength) > MAX_REVIEW_URL_RESPONSE_BYTES) {
      return blocked('COMMAND_BLOCKED', {
        command: '/review',
        reason: `Response exceeds the ${MAX_REVIEW_URL_RESPONSE_BYTES}-byte review material limit`,
      });
    }
    return {
      content: new TextDecoder('utf-8', { fatal: true }).decode(
        await readResponseBodyWithinLimit(resp, MAX_REVIEW_URL_RESPONSE_BYTES),
      ),
    };
  } catch (err) {
    if (err instanceof RangeError) {
      return blocked('COMMAND_BLOCKED', {
        command: '/review',
        reason: `Response exceeds the ${MAX_REVIEW_URL_RESPONSE_BYTES}-byte review material limit`,
      });
    }
    return blocked('REVIEW_URL_CONTENT_ENCODING_INVALID', {
      reason: 'response bytes are not valid UTF-8',
    });
  }
}

async function readResponseBodyWithinLimit(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('response body exceeds review material limit');
        throw new RangeError('response body exceeds review material limit');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
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

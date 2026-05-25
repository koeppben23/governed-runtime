/**
 * @module adapters/dns-resolution
 * @description DNS lookup adapter for fail-closed review URL target validation.
 */

import { lookup } from 'node:dns/promises';

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type ReviewDnsLookup = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export const lookupReviewHostname: ReviewDnsLookup = async (hostname) => {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((result) => ({ address: result.address, family: result.family as 4 | 6 }));
};

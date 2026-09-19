/**
 * @module discovery/errors
 * @description Typed discovery errors shared across collector execution.
 */

/** Compile-time validated discovery error codes. */
export type DiscoveryErrorCode = 'DISCOVERY_COLLECTOR_TIMEOUT' | 'DISCOVERY_CODE_SURFACE_TIMEOUT';

/** Typed error shared by discovery collector boundaries. */
export class DiscoveryError extends Error {
  readonly code: DiscoveryErrorCode;

  constructor(code: DiscoveryErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DiscoveryError';
    this.code = code;
  }
}

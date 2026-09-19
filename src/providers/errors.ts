/**
 * @module providers/errors
 * @description Typed provider errors shared by assertion provider extensions.
 */

/** Compile-time validated provider error codes. */
export type ProviderErrorCode = 'PROVIDER_CODEC_KIND_MISMATCH';

/** Typed error shared by assertion provider identity codecs. */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;

  constructor(code: ProviderErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProviderError';
    this.code = code;
  }
}

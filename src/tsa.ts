/**
 * @module tsa
 * @description RFC 3161 Timestamp Authority subpath export.
 *
 * This module requires the optional `asn1js` and `pkijs` packages.
 * Import via: import { ... } from '@flowguard/core/tsa'
 *
 * If these packages are not installed, importing this module will throw.
 *
 * @version v1
 */

export { HttpTimestampAuthorityProvider } from './audit/rfc3161-http-provider.js';
export { PkijsTimestampVerifier } from './audit/rfc3161-pkijs-verifier.js';

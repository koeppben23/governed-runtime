/**
 * @module audit/constant-time
 * @description Constant-time byte comparison for cryptographic imprint
 * verification (TSA4): no early exit, accumulation over the full length,
 * including length-difference folding.
 */

export function constantTimeBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  const length = Math.max(left.byteLength, right.byteLength);
  let diff = left.byteLength ^ right.byteLength;
  for (let i = 0; i < length; i++) {
    const a = i < left.byteLength ? left[i]! : 0;
    const b = i < right.byteLength ? right[i]! : 0;
    diff |= a ^ b;
  }
  return diff === 0;
}

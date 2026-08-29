/**
 * @module integration/review/review-continuation
 * @description Re-export barrel preserving the historical import surface.
 *
 * The canonical continuation authority now lives in
 * `src/state/review-continuation.js` so the machine layer can project it
 * into NextAction without importing the integration layer.
 *
 * @version v1
 */

export { resolveReviewContinuation } from '../../state/review-continuation.js';
export type { ReviewContinuation } from '../../state/review-continuation.js';

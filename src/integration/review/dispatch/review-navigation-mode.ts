/**
 * @module integration/review/review-navigation-mode
 * @description Strict experimental mode resolver for the DREP navigation index.
 *
 * The flag is intentionally transient: it selects prompt composition only, is
 * read from the immutable host-process environment, and never persists state,
 * binds evidence, or changes review authority. Unknown values are rejected
 * instead of silently degrading a benchmark run to the baseline prompt.
 *
 * @version v1
 */

import { IntegrationInvariantError } from '../../errors.js';

export const REVIEW_NAVIGATION_ENV = 'FLOWGUARD_REVIEW_NAVIGATION';

export type ReviewNavigationMode = 'off' | 'on';

/**
 * Resolve the mode once per prompt build from the process environment. The
 * environment is fixed for a host process and for a demo run, so an attempt and
 * its re-arms always compose the same variant.
 */
export function resolveReviewNavigationMode(
  env: NodeJS.ProcessEnv = process.env,
): ReviewNavigationMode {
  const raw = env[REVIEW_NAVIGATION_ENV];
  if (raw === undefined || raw === 'off') return 'off';
  if (raw === 'on') return 'on';
  throw new IntegrationInvariantError(
    'CONFIGURATION_INVALID',
    `${REVIEW_NAVIGATION_ENV} must be exactly "on" or "off" when set; refusing to silently fall back to the baseline prompt.`,
  );
}

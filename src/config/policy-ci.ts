/**
 * @module config/policy-ci
 * @description CI-context detection for policy resolution.
 */

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

/**
 * Detect whether this process runs in a CI context.
 *
 * Conservative default: false when context is missing or unclear.
 */
export function detectCiContext(env: Record<string, string | undefined> = process.env): boolean {
  const ciSignals = [
    env.CI,
    env.GITHUB_ACTIONS,
    env.GITLAB_CI,
    env.BUILDKITE,
    env.JENKINS_URL,
    env.TF_BUILD,
    env.TEAMCITY_VERSION,
    env.CIRCLECI,
    env.DRONE,
    env.BITBUCKET_BUILD_NUMBER,
    env.BUILDKITE_BUILD_ID,
  ];
  return ciSignals.some(isTruthyEnv);
}

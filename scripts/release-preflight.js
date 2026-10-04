/**
 * @module scripts/release-preflight
 * @description Single decision authority for release-tag safety.
 *
 * The same pure decisions are used by two evidence phases:
 *
 * - PRE-TAG (`npm run release:assert-main-tag`): runs before the tag exists and
 *   proves the local repository state is safe to tag.
 * - POST-TAG (`node scripts/verify-release-tag.js`): runs in the tag-triggered
 *   release workflow and proves the pushed remote tag is an annotated,
 *   GitHub-verified signature over the current protected `main` commit.
 *
 * Both phases stay fail-closed: an absent or ambiguous input is a failure. The
 * decisions are pure; callers gather git/API state and render the failures.
 *
 * @version v1
 */

/** Valid release tag, for example `v2.0.0-tp.1` or `v1.2.0`. */
export const RELEASE_TAG_PATTERN = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Version part of a release tag without the `v` prefix. */
export function releaseVersionOf(tag) {
  return typeof tag === 'string' && tag.startsWith('v') ? tag.slice(1) : '';
}

/**
 * @param {string | undefined} tag
 * @returns {string | null} Failure message or `null` when the tag name is usable.
 */
export function validateReleaseTagName(tag) {
  if (!tag || !RELEASE_TAG_PATTERN.test(tag)) {
    return 'tag argument must look like v1.2.0 or v1.2.0-rc.4';
  }
  return null;
}

/**
 * PRE-TAG decision. Every field is explicit so local callers can be tested
 * without git state.
 *
 * @param {{
 *   tag: string,
 *   branch: string,
 *   clean: boolean,
 *   head: string,
 *   originMain: string,
 *   localTagExists: boolean,
 *   remoteTagExists: boolean,
 *   packageVersion: string,
 *   versionFile: string,
 *   changelogHasReleaseSection: boolean,
 * }} input
 * @returns {readonly string[]} Failures; empty means safe to tag.
 */
export function evaluateReleasePreTag(input) {
  const tagError = validateReleaseTagName(input.tag);
  if (tagError) return [tagError];

  const failures = [];
  if (input.branch !== 'main') {
    failures.push(
      `release tags must be created from main, current branch is ${input.branch || '(detached)'}`,
    );
  }
  if (!input.clean) {
    failures.push('working tree must be clean before tagging');
  }
  if (input.head !== input.originMain) {
    failures.push('HEAD must equal origin/main before tagging');
  }
  if (input.localTagExists) {
    failures.push(`local tag already exists: ${input.tag}`);
  }
  if (input.remoteTagExists) {
    failures.push(`remote tag already exists: ${input.tag}`);
  }
  const version = releaseVersionOf(input.tag);
  if (input.packageVersion !== version || input.versionFile !== version) {
    failures.push(`package.json and VERSION must both equal ${version}`);
  }
  if (!input.changelogHasReleaseSection) {
    failures.push(`CHANGELOG.md must contain a dated [${version}] release section`);
  }
  return failures;
}

/**
 * POST-TAG decision for the tagged commit in CI. `refObjectType` must be
 * `tag` (annotated), the verified signature is mandatory, and the tagged
 * commit must be the exact current protected `main` commit.
 *
 * @param {{
 *   tag: string,
 *   refObjectType: string,
 *   taggedCommit: string,
 *   originMain: string,
 *   verificationVerified: boolean,
 *   packageVersion: string,
 *   versionFile: string,
 *   changelogHasReleaseSection: boolean,
 * }} input
 * @returns {readonly string[]} Failures; empty means the tag is provenance-clean.
 */
export function evaluateReleasePostTag(input) {
  const tagError = validateReleaseTagName(input.tag);
  if (tagError) return [tagError];

  const failures = [];
  if (input.refObjectType !== 'tag') {
    failures.push(
      `release tag ${input.tag} must be an annotated tag object (got ${input.refObjectType || 'missing'})`,
    );
  }
  if (!input.verificationVerified) {
    failures.push(`release tag ${input.tag} must carry a GitHub-verified signature`);
  }
  if (!input.taggedCommit || input.taggedCommit !== input.originMain) {
    failures.push('tagged commit must equal the current protected main commit');
  }
  const version = releaseVersionOf(input.tag);
  if (input.packageVersion !== version || input.versionFile !== version) {
    failures.push(`package.json and VERSION must both equal ${version}`);
  }
  if (!input.changelogHasReleaseSection) {
    failures.push(`CHANGELOG.md must contain a dated [${version}] release section`);
  }
  return failures;
}

/** `true` when the release must be published as a GitHub prerelease. */
export function isPrereleaseVersion(input) {
  const version = typeof input === 'string' ? input.replace(/^v/, '') : '';
  return version.includes('-');
}

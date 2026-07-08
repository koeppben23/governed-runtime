# GitHub Branch Protection

This document defines the active repository ruleset for the protected `main` and
`develop` branches.

`main` is the release authority and must remain release-ready. `develop` is the
protected integration branch for main-ready work before a release cut.

## Rule Target

- Branch name patterns: `main`, `develop`

## Required Protection Settings

| Setting                                      | Value     |
| -------------------------------------------- | --------- |
| Require a pull request before merging        | Enabled   |
| Required approvals                           | 1 or more |
| Dismiss stale reviews                        | Enabled   |
| Require review thread resolution             | Enabled   |
| Require status checks to pass before merging | Enabled   |
| Require branch to be up to date before merge | Enabled   |
| Require linear history                       | Enabled   |
| Do not allow bypassing the above settings    | Enabled   |
| Do not allow force pushes                    | Enabled   |
| Do not allow deletion                        | Enabled   |

## Required Status Checks

Only real CI job names are allowed in this list. Configure the following check
names exactly in the `Protect main and develop` ruleset.

From `.github/workflows/ci.yml`:

- `test`
- `typecheck`
- `lint`
- `format`
- `architecture`
- `build`
- `actionlint`
- `secrets-scan`
- `security-policy`
- `install-verify (ubuntu-latest)`
- `install-verify (macos-latest)`
- `install-verify (windows-latest)`
- `independent-review-e2e`

The `format` check is the merge-blocking Prettier gate for both protected
branches.

From `.github/workflows/conventional-commits.yml`:

- `Validate Commit Messages`

From `.github/workflows/security.yml`:

- `audit`
- `codeql-sast`

## Non-blocking CI Jobs

The following jobs run but are intentionally not required by the live ruleset:

| Job                   | Why non-blocking                                                                                                                                                                                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unit`                | Runs as a direct job, but the required `test` aggregator is the branch-protection check.                                                                                                                                                                                                               |
| `integration`         | Runs as a direct job, but the required `test` aggregator is the branch-protection check.                                                                                                                                                                                                               |
| `sdk-baseline`        | Snapshot comparison against upstream SDK/host baselines; drift is informational and acted on via a separate update workflow (`scripts/check-opencode-host-drift.mjs`).                                                                                                                                |
| `unused-dependencies` | `knip --dependencies`; a false positive should not block a release. Review the diff manually.                                                                                                                                                                                                         |
| `fuzz`                | `fast-check` property tests with a fixed seed. Deep fuzzing runs on the nightly schedule (`fuzz-nightly.yml`); regressions block via the nightly cadence, not the PR.                                                                                                                                 |
| `mutation`            | Stryker runs on the nightly/release cadence (`mutation.yml`), not per-PR. A reliable per-PR incremental gate is not achievable with the current perTest + vitest-runner setup (see the workflow rationale); it is therefore not a required check.                                                     |
| `dependency-review`   | `fail-on-severity: high` is configured; runs as advisory (`continue-on-error: true`) because Dependency Graph is not yet enabled for this repository. Will become a required check after the repo setting is toggled on.                                                                               |

If any of these is promoted to merge-blocking, move it to the required list
above in the same PR that flips the ruleset setting.

## Source Of Truth

- Live GitHub ruleset: `Protect main and develop`
- CI workflow: `.github/workflows/ci.yml`
- Security workflow: `.github/workflows/security.yml`
- Commit title check: `.github/workflows/conventional-commits.yml`

If CI job names change, update this file and the ruleset required-check list together.

## Quick Validation Steps

1. Open `Settings -> Rules -> Rulesets -> Protect main and develop`.
2. Verify `refs/heads/main` and `refs/heads/develop` are included.
3. Verify all settings in this file are enabled.
4. Verify all required check names above are present and exact.
5. Open a test PR and confirm merge stays blocked until all required checks pass.

## Emergency Procedure

Use admin override only for incident response:

1. Record incident context and approver.
2. Apply emergency fix.
3. Re-enable full protection immediately.
4. Create post-incident review entry.

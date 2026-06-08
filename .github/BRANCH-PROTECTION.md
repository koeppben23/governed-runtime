# GitHub Branch Protection

This document defines the merge-blocking settings for the `main` branch.

## Rule Target

- Branch name pattern: `main`

## Required Protection Settings

| Setting                                      | Value     |
| -------------------------------------------- | --------- |
| Require a pull request before merging        | Enabled   |
| Required approvals                           | 1 or more |
| Dismiss stale reviews                        | Enabled   |
| Require status checks to pass before merging | Enabled   |
| Do not allow bypassing the above settings    | Enabled   |
| Do not allow force pushes                    | Enabled   |
| Do not allow deletion                        | Enabled   |

## Required Status Checks (merge-blocking)

Only real CI job names are allowed in this list. Configure the following check names exactly:

From `.github/workflows/conventional-commits.yml`:

1. `Validate Commit Messages`

From `.github/workflows/ci.yml`:

2. `unit`
3. `test`
4. `integration`
5. `architecture`
6. `typecheck`
7. `lint`
8. `format`
9. `actions-pinning`
10. `build`
11. `install-verify (ubuntu-latest)`
12. `install-verify (macos-latest)`
13. `install-verify (windows-latest)`
14. `smoke`
15. `independent-review-e2e`
16. `audit`
17. `mutation`
18. `actionlint`
19. `secrets-scan`
20. `codeql-sast`
21. `security-policy`
22. `install (ubuntu-latest)`
23. `install (macos-latest)`
24. `install (windows-latest)`

`install-verify (...)` and `install (...)` are distinct required jobs and must both stay aligned with CI truth.

## Non-blocking CI Jobs

The following jobs exist in `.github/workflows/ci.yml` but are intentionally
**not** added to the required-check list. They run on every PR and surface as
warnings rather than gates:

| Job                    | Why non-blocking                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `sdk-baseline`         | Snapshot comparison against upstream SDK/host baselines; drift is informational and acted on via a separate update workflow (`scripts/check-opencode-host-drift.mjs`). |
| `unused-dependencies`  | `knip --dependencies`; a false positive should not block a release. Review the diff manually.      |
| `fuzz`                 | `fast-check` property tests with a fixed seed (~100 iterations). Deep fuzzing runs on the nightly schedule (`fuzz-nightly.yml`); regressions block via the nightly cadence, not the PR. |

If any of these is promoted to merge-blocking, move it to the required list
above in the same PR that flips the branch-protection setting.

## Source of Truth

- Workflow file: `.github/workflows/ci.yml`
- Commit title check workflow: `.github/workflows/conventional-commits.yml`

If CI job names change, update this file and the branch protection required-check list together.

## Quick Validation Steps

1. Open `Settings -> Branches -> Branch protection rules -> main`.
2. Verify all settings in this file are enabled.
3. Verify all required check names above are present and exact.
4. Open a test PR and confirm merge stays blocked until all required checks pass.

## Emergency Procedure

Use admin override only for incident response:

1. Record incident context and approver.
2. Apply emergency fix.
3. Re-enable full protection immediately.
4. Create post-incident review entry.

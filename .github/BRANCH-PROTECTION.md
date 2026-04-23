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

These check names must be configured exactly as required checks:

1. `Validate Commit Messages`
2. `test`
3. `typecheck`
4. `lint`
5. `format`
6. `build`
7. `install-verify (ubuntu-latest)`
8. `install-verify (macos-latest)`
9. `install-verify (windows-latest)`
10. `acp-smoke`
11. `audit`
12. `actionlint`
13. `secrets-scan`
14. `codeql-sast`
15. `security-policy`

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

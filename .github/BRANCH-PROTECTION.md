# GitHub Branch Protection

This document defines the active repository ruleset for the protected `main` and
`develop` branches.

`main` is the release authority and must remain release-ready. `develop` is the
protected integration branch for main-ready work before a release cut.

## Rule Target

- Branch name patterns: `main`, `develop`

## Required Protection Settings

| Setting                                      | Value   |
| -------------------------------------------- | ------- |
| Require a pull request before merging        | Enabled |
| Required approvals                           | 0       |
| Dismiss stale reviews                        | Enabled |
| Require review thread resolution             | Enabled |
| Require status checks to pass before merging | Enabled |
| Require branch to be up to date before merge | Enabled |
| Require linear history                       | Enabled |
| Do not allow bypassing the above settings    | Enabled |
| Do not allow force pushes                    | Enabled |
| Do not allow deletion                        | Enabled |

## Required Status Checks

Only real CI job names are allowed in this list. Configure the following check
names exactly in the `Protect main and develop` ruleset.

From `.github/workflows/ci.yml`:

- `ci-gate` (aggregates `unit` + `scripts-windows` + `coverage` + `integration-perf` + `provider-conformance` + `regulated-e2e`)
- `typecheck`
- `lint`
- `format`
- `architecture`
- `build`
- `build-clean`
- `actionlint`
- `secrets-scan`
- `security-policy`
- `install-verify (ubuntu-latest)`
- `install-verify (macos-latest)`
- `install-verify (windows-latest)`
- `independent-review-e2e`

`architecture` is the stable required aggregator for the Linux and Windows
architecture workers (`architecture-linux`, `architecture-windows`). The
platform workers are implementation details and are not configured
individually as branch-protection contexts.

`scripts-windows` runs the repository script tests on Windows and is
merge-blocking through the required `ci-gate` aggregator; the Ubuntu `unit` job
runs the same suite as its second step.

The `format` check is the merge-blocking Prettier gate for both protected
branches. Mutation testing is deliberately NOT a PR gate: it runs on the
scheduled/release cadence via `.github/workflows/mutation.yml` (the full-suite
Stryker run is too expensive for per-PR execution; per-PR mutation was
evaluated and rejected). The real-plugin mutation-episode E2E runs inside
`coverage` (unit + integration projects on the final SHA).

From `.github/workflows/conventional-commits.yml`:

- `Validate Commit Messages`

From `.github/workflows/security.yml`:

- `audit`
- `codeql-sast`

Every required check must be bound to the GitHub Actions app
(`integration_id` 15368) where the platform supports the binding; the drift
check fails when a check loses that binding.

## Solo Maintainer Review Model

This repository uses a solo-maintainer ruleset: GitHub cannot count the PR
author's own approval toward required approvals, so the live ruleset does not
require a separate approving reviewer. Lead-level protection is enforced through
mandatory PRs, strict required checks, branch freshness, linear history,
resolved review threads, and deletion/force-push protection.

External review remains recommended for high-risk release, security, persistence,
policy, identity, audit, archive, installer, and CI changes when a second
reviewer is available.

A solo repository owner cannot achieve separation of duties from themselves.
This is an explicitly accepted residual risk: no repository-local control can
prevent the owner from editing the rulesets, the environment, or the workflow
files. The compensating controls are fail-closed verification in the release
workflow, immutable tags, the publication wait timer, the control-plane drift
detection, and the auditable configuration recorded in this file.

### Owner-Account Compromise Recovery

If the owner account may be compromised:

1. Revoke all GitHub sessions, tokens, and registered SSH keys; re-authenticate
   with recovered credentials.
2. Lock or rotate deployment credentials (package registry, release
   environment) and any external secrets.
3. Inspect ruleset, tag, and release history for unauthorized changes; restore
   the contract from `scripts/control-plane-contract.js`.
4. Invalidate suspect releases and attestations; publish a new immutable tag
   through the protected release process after remediation.
5. Record the incident and, where required, publish a follow-up advisory.

Use the emergency procedure below only with recorded scope and expiry, and
re-enable every control immediately after recovery.

## Non-blocking CI Jobs

The following jobs run but are intentionally **not** required by the live ruleset:

| Job                    | Why non-blocking                                                                                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unit`                 | Runs as a direct job, but the required `ci-gate` aggregator is the branch-protection check.                                                                                                                                                                         |
| `coverage`             | Not configured as a direct required check, but transitively merge-blocking through the required `ci-gate` aggregator.                                                                                                                                               |
| `integration-perf`     | Not configured as a direct required check, but transitively merge-blocking through the required `ci-gate` aggregator.                                                                                                                                               |
| `provider-conformance` | Not configured as a direct required check, but transitively merge-blocking through the required `ci-gate` aggregator.                                                                                                                                               |
| `regulated-e2e`        | Not configured as a direct required check, but transitively merge-blocking through the required `ci-gate` aggregator.                                                                                                                                               |
| `sdk-baseline`         | Snapshot comparison against upstream SDK/host baselines; drift is informational and acted on via a separate update workflow (`scripts/check-opencode-host-drift.mjs`).                                                                                              |
| `unused-dependencies`  | `knip --dependencies`; a false positive should not block a release. Review the diff manually.                                                                                                                                                                       |
| `fuzz`                 | `fast-check` property tests with a fixed seed. Deep fuzzing runs on the nightly schedule (`fuzz-nightly.yml`); regressions block via the nightly cadence, not the PR.                                                                                               |
| `mutation`             | Stryker runs on the weekly/release cadence (Mondays 02:00 UTC, `mutation.yml`), not per-PR. A reliable per-PR incremental gate is not achievable with the current perTest + vitest-runner setup (see the workflow rationale); it is therefore not a required check. |
| `dependency-review`    | `fail-on-severity: high` is configured; runs as advisory (`continue-on-error: true`) because Dependency Graph is not yet enabled for this repository. Will become a required check after the repo setting is toggled on.                                            |

If any of these is promoted to merge-blocking, move it to the required list
above in the same PR that flips the ruleset setting.

## Tag Protection

Release tags are protected by two separate rulesets. The split is deliberate: a
single combined ruleset would let the creation bypass weaken the
immutability rules.

| Ruleset                          | Target | Rules                                         | Bypass                         |
| -------------------------------- | ------ | --------------------------------------------- | ------------------------------ |
| `Release tag creation authority` | `v*`   | Restrict creations                            | Release actor (the maintainer) |
| `Release tag immutability`       | `v*`   | Restrict updates, deletions, non-fast-forward | No normal bypass               |

Both rulesets pin the ref target to exactly `refs/tags/v*` with no excludes, and
the contract pins the exact bypass actor and mode (`User:57482452:always` for
creation, none for immutability). The rulesets make `v*` tags immutable for
normal actors while still allowing the release authority to create them. The
tag-triggered release workflow additionally enforces, before any write-capable
step, that the pushed tag is an annotated tag object, carries a
GitHub-verified signature, and points at the exact current protected `main`
commit.

## Release Environment

Release publication runs behind the protected `release` environment with a
15-minute wait timer. The timer is an anti-impulse and recovery window, not a
claim of independent approval. The environment uses custom deployment
policies only (`custom_branch_policies: true`, `protected_branches: false`)
restricted to `v*` tags; the drift check verifies both the policy mode and the
tag pattern.

## Control-Plane Drift Detection

`scripts/control-plane-contract.js` is the single structured authority for the
relied-upon GitHub configuration. `scripts/control-plane-drift.js` compares it
against the live rulesets and the release environment and fails closed on any
missing or divergent setting. It runs:

- read-only on pull requests that touch `.github/**` or the control-plane
  scripts, and
- scheduled and on demand, with a separate remediation job that holds
  `issues: write` and opens at most one open `control-plane-drift` issue.

`bypass_actors` is only visible to callers with enough ruleset access. The
contract pins the exact actors, so verification has two modes:

- **strict** (scheduled runs and the release POST-TAG preflight): every
  relied-upon setting, including the exact `bypass_actors` and the Actions
  policy, must be readable and correct. Hidden actor evidence fails the run.
- **partial** (pull-request runs only, no privileged secret): everything
  readable must match; hidden `bypass_actors` or an unreadable Actions policy
  report `PARTIAL_VERIFICATION` instead of a false full match.

Strict verification needs a read-only token with `Administration: read`,
stored as the repository secret `CONTROL_PLANE_READ_TOKEN` (fine-grained PAT)
and exposed to the drift workflow and the release preflight as
`CONTROL_PLANE_TOKEN`. Without it, trusted runs fail closed.

## Actions Policy

The repository Actions policy is part of the release supply chain and is
verified against `ACTIONS_POLICY_CONTRACT`:

| Setting             | Required value |
| ------------------- | -------------- |
| Actions enabled     | `true`         |
| Allowed actions     | `all`          |
| Require SHA pinning | `true`         |

## Source Of Truth

- Live branch/tag rulesets: `Protect main and develop`, `Release tag creation
authority`, `Release tag immutability`
- Actions policy: repository Actions permissions API
- Structured contract: `scripts/control-plane-contract.js`
- Drift detection: `scripts/control-plane-drift.js`
- Release preflight: `scripts/verify-release-tag.js` (tag-triggered workflow)
- CI workflow: `.github/workflows/ci.yml`
- Security workflow: `.github/workflows/security.yml`
- Commit title check: `.github/workflows/conventional-commits.yml`

If CI job names change, update the contract, this file, and the ruleset
required-check list together.

## Quick Validation Steps

1. Run `CONTROL_PLANE_TOKEN=<read-token> node scripts/control-plane-drift.js
--mode strict --verbose --repo owner/name` and confirm it reports
   `control-plane-drift OK`.
2. Verify the two `v*` rulesets, their exact bypass actors, and the
   `release` environment wait timer (15 minutes) and its `v*` tag deployment
   policy through the same strict run.
3. Open a test PR and confirm merge stays blocked until all required checks pass.

## Emergency Procedure

Use admin override only for incident response:

1. Record incident context and approver.
2. Apply emergency fix.
3. Re-enable full protection immediately.
4. Create post-incident review entry.

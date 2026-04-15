# GitHub Repository Settings

## Branch Protection Rules for `main`

To protect the `main` branch, configure the following rules in GitHub:

### Settings Location
`Settings → Branches → Branch protection rules → Add rule`

### Rule Configuration

| Setting | Value | Description |
|---------|-------|-------------|
| **Branch name pattern** | `main` | Apply to main branch |
| **Require a pull request before merging** | ✅ Enabled | No direct commits to main |
| **Require approvals** | ✅ 1 (or more) | At least one approval required |
| **Dismiss stale reviews** | ✅ Enabled | Reviews dismissed when new commits push |
| **Require status checks to pass before merging** | ✅ Enabled | CI must be green |
| **Required status checks** | `CI`, `conventional-commits` | Only these checks required |
| **Do not allow bypassing the above settings** | ✅ Enabled | Even admins must follow rules |
| **Do not allow force pushes** | ✅ Enabled | No force push to main |
| **Do not allow deletion** | ✅ Enabled | Cannot delete main branch |

### Status Checks

The following GitHub Actions must pass:

1. **CI** (`.github/workflows/ci.yml`)
   - Runs: `npm test`, `npm run check`, `npm run build`
   - Triggered on: push to main, pull_request to main

2. **conventional-commits** (`.github/workflows/conventional-commits.yml`)
   - Validates: PR titles (on PR) or commit messages (on push)
   - Triggered on: pull_request to main, push to main

### Repository Rulesets (Alternative)

Instead of branch protection rules, you can use GitHub's new Rulesets:

1. Go to **Settings → Rules → Rulesets**
2. Create a new ruleset for **main**
3. Add the same restrictions as above

---

## Admin Override

For emergency situations, a repository admin can:

1. Temporarily disable branch protection
2. Make the emergency fix
3. Re-enable protection immediately

**Note:** This should be logged and reviewed post-incident.

---

## CI/CD Pipeline Overview

```
┌─────────────┐     PR opened     ┌──────────────────┐
│  Developer  │ ─────────────────▶│  GitHub Actions  │
└─────────────┘                   └────────┬─────────┘
       ▲                                   │
       │                                   ▼
       │                            ┌──────────────┐
       │                            │ CI Workflow  │
       │                            │ - npm test   │
       │                            │ - npm check  │
       │                            │ - npm build  │
       │                            └──────┬───────┘
       │                                   │
       │                            ┌──────┴───────┐
       │                            │ Conv. Commits │
       │                            │ - PR title    │
       │                            │ - Commits     │
       │                            └──────┬───────┘
       │                                   │
       │                                   ▼
       │                            ┌──────────────┐
       │                            │   Results     │
       │                            └──────┬───────┘
       │                                   │
       │                    ┌──────────────┴──────────────┐
       │                    ▼                                 ▼
       │             ┌───────────┐                   ┌───────────┐
       │             │  PASSED   │                   │  FAILED   │
       │             └─────┬─────┘                   └───────────┘
       │                   │                               │
       │                   ▼                               ▼
       │             PR Merged                      Fix Required
       │                                                   │
       │                                                   ▼
       └───────────────────────────────────────── Back to PR
```

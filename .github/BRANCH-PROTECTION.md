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
| **Require status checks to pass before merging** | ✅ Enabled | All checks must be green |
| **Required status checks** | `test`, `typecheck`, `lint`, `format`, `build`, `install-verify (ubuntu-latest)`, `install-verify (macos-latest)`, `install-verify (windows-latest)`, `audit`, `actionlint`, `security-policy`, `install (ubuntu-latest)`, `install (macos-latest)`, `install (windows-latest)`, `Validate Commit Messages` | All CI job names listed individually |
| **Do not allow bypassing the above settings** | ✅ Enabled | Even admins must follow rules |
| **Do not allow force pushes** | ✅ Enabled | No force push to main |
| **Do not allow deletion** | ✅ Enabled | Cannot delete main branch |

### Status Checks

The following GitHub Actions jobs must pass:

1. **test** (`.github/workflows/ci.yml` — job `test`)
   - Runs: `npm test` with coverage
   - Platform: ubuntu-latest

2. **typecheck** (`.github/workflows/ci.yml` — job `typecheck`)
   - Runs: `npm run check` (tsc --noEmit)
   - Platform: ubuntu-latest

3. **lint** (`.github/workflows/ci.yml` — job `lint`)
   - Runs: `npm run lint` (ESLint)
   - Platform: ubuntu-latest

4. **format** (`.github/workflows/ci.yml` — job `format`)
   - Runs: `npm run format` (Prettier check)
   - Platform: ubuntu-latest

5. **build** (`.github/workflows/ci.yml` — job `build`)
   - Runs: `npm run build`
   - Platform: ubuntu-latest

6. **install-verify (ubuntu-latest)**, **install-verify (macos-latest)**, **install-verify (windows-latest)** (`.github/workflows/ci.yml` — job `install-verify`)
   - Runs: smoke tests on installed package
   - Platform: matrix across ubuntu, macOS, Windows

7. **audit** (`.github/workflows/ci.yml` — job `audit`)
   - Runs: `npm audit --audit-level=high`
   - Platform: ubuntu-latest

8. **actionlint** (`.github/workflows/ci.yml` — job `actionlint`)
   - Runs: `actionlint` on workflow files
   - Platform: ubuntu-latest

9. **security-policy** (`.github/workflows/ci.yml` — job `security-policy`)
   - Checks: SECURITY.md exists, vulnerability reporting enabled
   - Platform: ubuntu-latest

10. **codeql-sast** (`.github/workflows/ci.yml` — job `codeql-sast`)
    - Runs: CodeQL static analysis
    - Platform: ubuntu-latest

11. **secrets-scan** (`.github/workflows/ci.yml` — job `secrets-scan`)
    - Runs: Gitleaks for secret detection
    - Platform: ubuntu-latest

12. **install (ubuntu-latest)**, **install (macos-latest)**, **install (windows-latest)** (`.github/workflows/ci.yml` — job `install`)
    - Runs: build → `flowguard install` → `flowguard doctor`
    - Platform: matrix across ubuntu, macOS, Windows

13. **Validate Commit Messages** (`.github/workflows/conventional-commits.yml`)
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
       │        ┌────────────────────────────┼────────────────────────────┐
       │        ▼            ▼            ▼            ▼            ▼       │
       │   ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐   │
       │   │  test   │  │typecheck│  │  lint  │  │ format │  │ build  │   │
       │   │npm test │  │ tsc -no│  │eslint │  │prettier│  │tsc+esm│   │
       │   └──┬────┘  └──┬────┘  └──┬────┘  └──┬────┘  └──┬────┘   │
       │        │         │         │         │         │         │       │
       │        ▼         ▼         ▼         ▼         ▼         ▼    │
       │   ┌─────────┐  ┌─────────┐  ┌───┐  ┌───────┐  ┌────┐  │
       │   │ typecheck audit  │  │actionlint│codeql │secrets│
       │   └────┬────┘  └────┬────┘  └─┬─┘  └─────┬┘  └───┬─┘
       │        │         │         │         │         │
       │        ▼         ▼         ▼         ▼         ▼
       │   ┌──────────────────────────────────────────────┐
       │   │   install-verify (ubuntu/macOS/Windows)    │
       │   │   smoke tests on installed package        │
       │   └─────────────────┬───────────────────────┘
       │                     │
       │        ┌────────────┼────────────┬───────────────┐
       │        ▼            ▼            ▼               ▼
       │   ┌──────────┐ ┌─────────┐ ┌──────────┐  ┌──────────────┐
       │   │ Validate │ │ install │ │security- │  │  Results   │
       │   │ Commits  │ │ doctor  │ │policy   │  └─────┬──────┘
       │   └────┬────┘ └────┬────┘ └────┬───┘        │
       │        │          │          │    ┌───────┴───────┐
       │        │          │          │    ▼            ▼
       │        │          │          │ ┌─────────┐ ┌─────────┐
       │        │          │          │ │ PASSED  │ │ FAILED │
       │        ▼          ▼          │ └────┬────┘ └─────────┘
       │    PR Merged       Fix Required│     │
       │                               └─────┘
       └───────────────────────────────────┘
```
┌─────────────┐     PR opened     ┌──────────────────┐
│  Developer  │ ─────────────────▶│  GitHub Actions  │
└─────────────┘                   └────────┬─────────┘
       ▲                                   │
       │                      ┌────────────┼────────────┐
       │                      ▼            ▼            ▼
       │               ┌───────────┐ ┌──────────┐ ┌──────────┐
       │               │   test    │ │ typecheck │ │  build   │
       │               │ npm test  │ │ tsc check │ │ tsc+esm  │
       │               └─────┬─────┘ └────┬─────┘ └────┬─────┘
       │                     │             │            │
       │                     ▼             ▼            ▼
       │               ┌─────────────────────────────────────┐
       │               │  install (ubuntu / macOS / Windows) │
       │               │  flowguard install → doctor         │
       │               └──────────────┬──────────────────────┘
       │                              │
       │                     ┌────────┴────────┐
       │                     ▼                 ▼
       │               ┌──────────┐     ┌──────────────┐
       │               │ Validate │     │   Results     │
       │               │ Commits  │     └──────┬───────┘
       │               └────┬─────┘            │
       │                    │       ┌──────────┴──────────┐
       │                    │       ▼                     ▼
       │                    │ ┌───────────┐       ┌───────────┐
       │                    │ │  PASSED   │       │  FAILED   │
       │                    │ └─────┬─────┘       └───────────┘
       │                    │       │                   │
       │                    ▼       ▼                   ▼
       │               PR Merged                 Fix Required
       │                                               │
       └───────────────────────────────────────────────┘
```

# Profiles

Profiles define validation rules and guidelines for different tech stacks.

## Built-in Profiles

The runtime `id` (used in `config.profile.defaultId`, the `/hydrate` slash
command's policy/profile selection, and audit evidence) is the value in the
first column. The display name is the second column and is not accepted as
an id.

| Profile id         | Display Name         | Description                      |
| ------------------ | -------------------- | -------------------------------- |
| `baseline`         | Baseline             | Universal rules for all projects |
| `typescript`       | TypeScript / Node.js | TS-specific validation           |
| `backend-java`     | Java / Spring Boot   | Java enterprise rules            |
| `frontend-angular` | Angular / Nx         | Angular-specific guidelines      |

Unknown ids in `config.profile.defaultId` are rejected fail-closed with
`INVALID_PROFILE`. Use the id, not the display name.

## Profile Detection

FlowGuard auto-detects the best profile based on:

- Repository structure
- Package manager
- Framework indicators
- Language files
- Database engine indicators from manifest evidence (dependencies and docker-compose images)

## Detected Stack and Verification Candidates

Profiles consume runtime stack evidence from `flowguard_status`:

- `detectedStack`: detected languages, frameworks, runtimes, build tools, tools, test frameworks, quality tools, databases, compiler targets, and module scopes with scoped versions
- `verificationCandidates`: advisory, evidence-backed verification commands (planner output)

Verification candidates are **planning hints only**. They are not auto-executed and do not represent completed checks.

Priority for candidate generation is repo-native and deterministic:

1. `package.json` scripts (for example `pnpm test` from `scripts.test`)
2. Java wrappers (`./mvnw`, `./gradlew`) when present
3. Tool defaults from detected stack as fallback (for example `pnpm vitest run`)

If no evidence exists, `verificationCandidates` is an empty array.

## Baseline Profile

The baseline profile provides minimal governance for projects without a
detected stack. Active checks are derived from `verificationCandidates` at
session creation — the profile itself declares no static checks.

When verification candidates are present, each unique `kind` becomes an
active check. Common kinds include `test`, `lint`, `typecheck`, `build`,
`format`, `security`, and `coverage`. When no verification candidates are
detected, VALIDATION is vacuously passed.

### Verification Commands

Verification commands are discovered automatically from the repository
(`package.json` scripts, Java wrappers, detected tool defaults). They
surface as `verificationCandidates` in `flowguard_status`. Use
`/check` to execute them.

Refer to `docs/configuration.md#profileactivechecks` for overriding active
checks at the config level.

## TypeScript Profile

Extends Baseline with TS-specific rules:

### Additional Checks

- Strict TypeScript compilation
- Type exports required
- No `any` types without annotation
- ESLint compliance

### Configuration

```json
{
  "rules": {
    "no-any": "error",
    "strict-null-checks": "error",
    "explicit-module-boundary-types": "error"
  }
}
```

## Java Profile

Extends Baseline with Java enterprise rules:

### Additional Checks

- No wildcard imports
- No TODO/FIXME without approval
- Spring Boot best practices
- JUnit test requirements

## Angular Profile

Extends Baseline with Angular-specific rules:

### Additional Checks

- Nx workspace compliance
- Angular CLI usage
- Component testing
- Strict mode enabled

## Custom Profiles

### Defining a Profile

Custom profiles are plain TypeScript objects shaped like the built-in profiles
(see `src/config/profile.ts` for the `ProfileDefinition` type). FlowGuard does
not export a `defineProfile()` factory wrapper; construct the object directly
and let TypeScript infer the structural type. The `@flowguard/core` package is
available after installation (see docs/installation.md):

```typescript
import type { ProfileDefinition } from '@flowguard/core';

export const myProfile: ProfileDefinition = {
  id: 'my-profile',
  displayName: 'My Custom Profile',
  signals: {
    language: ['typescript', 'javascript'],
    framework: ['express'],
  },
  activeChecks: [], // checks derived from verificationCandidates at hydrate-time
  instructions: {
    base: 'Follow Express.js best practices...',
    byPhase: {
      IMPLEMENTATION: 'Use dependency injection...',
    },
  },
};
```

### Registering a Profile

Register against the shared `defaultProfileRegistry` singleton (also exported
from `@flowguard/core` — available after installation, see
docs/installation.md), or instantiate your own `ProfileRegistry` for tests:

```typescript
import { defaultProfileRegistry, ProfileRegistry } from '@flowguard/core';

// Production: register on the default registry.
defaultProfileRegistry.register(myProfile);

// Tests: an isolated registry avoids leaking custom profiles between cases.
const testRegistry = new ProfileRegistry();
testRegistry.register(myProfile);
```

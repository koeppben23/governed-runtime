# Profiles

Profiles define validation rules and guidelines for different tech stacks.

## Built-in Profiles

| Profile    | Language/Framework | Description                      |
| ---------- | ------------------ | -------------------------------- |
| Baseline   | Any                | Universal rules for all projects |
| TypeScript | TypeScript/Node.js | TS-specific validation           |
| Java       | Java/Spring Boot   | Java enterprise rules            |
| Angular    | Angular/Nx         | Angular-specific guidelines      |

## Profile Detection

FlowGuard auto-detects the best profile based on:

- Repository structure
- Package manager
- Framework indicators
- Language files
- Database engine indicators from manifest evidence (dependencies and docker-compose images)

## Detected Stack and Verification Candidates

Profiles consume runtime stack evidence from `flowguard_status`:

- `detectedStack`: detected languages, frameworks, runtimes, build tools, and versions
- `verificationCandidates`: advisory, evidence-backed verification commands (planner output)

Verification candidates are **planning hints only**. They are not auto-executed and do not represent completed checks.

Priority for candidate generation is repo-native and deterministic:

1. `package.json` scripts (for example `pnpm test` from `scripts.test`)
2. Java wrappers (`./mvnw`, `./gradlew`) when present
3. Tool defaults from detected stack as fallback (for example `pnpm vitest run`)

If no evidence exists, `verificationCandidates` is an empty array.

## Baseline Profile

Universal rules for all projects:

### Test Quality

**Check:** `test_quality`
**Purpose:** Verify test coverage and quality

**Signals:**

- Presence of test files
- Test naming conventions
- Test frameworks detected

### Rollback Safety

**Check:** `rollback_safety`
**Purpose:** Ensure changes can be reverted

**Signals:**

- Version control usage
- Deployment documentation
- Rollback procedures

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

### Creating a Profile

```typescript
// Available after installation (see docs/installation.md)
import { defineProfile } from '@flowguard/core';

export const myProfile = defineProfile({
  id: 'my-profile',
  name: 'My Custom Profile',
  signals: {
    language: ['typescript', 'javascript'],
    framework: ['express'],
  },
  checks: ['test_quality', 'rollback_safety', 'my_custom_check'],
  instructions: {
    base: 'Follow Express.js best practices...',
    byPhase: {
      IMPLEMENTATION: 'Use dependency injection...',
    },
  },
});
```

### Registering a Profile

```typescript
// Available after installation (see docs/installation.md)
import { profileRegistry } from '@flowguard/core';

profileRegistry.register(myProfile);
```

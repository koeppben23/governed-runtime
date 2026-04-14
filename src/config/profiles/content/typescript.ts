/**
 * @module config/profiles/content/typescript
 * @description TypeScript (Node.js / general) profile rule content for LLM guidance.
 *
 * This content is injected into governance tool responses when the TypeScript
 * profile is active. It supplements the universal AGENTS.md mandates with
 * TypeScript-specific naming, architecture, testing, and anti-pattern rules.
 *
 * NEW: This profile did not exist in the old system. Created for the
 * TypeScript governance system itself and general TypeScript/Node.js projects.
 *
 * @version v1
 */

export const profileRuleContent = `
# TypeScript Profile Rules

These rules supplement the universal governance mandates. They apply when the
governance system detects a TypeScript/Node.js stack in the repository.

---

## 1. Repo Conventions Lock

Before code changes, detect and lock:
- TypeScript version and strictness level (strict, strictNullChecks, etc.)
- Runtime (Node.js version, Deno, Bun)
- Package manager (npm, pnpm, yarn) and lockfile
- Module system (ESM vs CJS, tsconfig module/moduleResolution)
- Test framework (Vitest, Jest, Mocha, node:test)
- Lint/format (ESLint, Biome, Prettier, oxlint)
- Build tool (tsc, esbuild, swc, tsup, tsx)
- Framework (Express, Fastify, Hono, NestJS, or none)

Once detected, these become constraints. If not detectable, mark as unknown and avoid introducing new patterns.

---

## 2. Type System Rules

### 2.1 Strict Mode
- All code MUST compile under the repo's tsconfig strictness level.
- Prefer stricter settings: \`strict: true\`, \`noUncheckedIndexedAccess: true\`.

### 2.2 Type Safety
- Do NOT use \`any\` unless absolutely necessary and documented with rationale.
- Prefer \`unknown\` over \`any\` for untyped external data.
- Use type narrowing (type guards, discriminated unions) instead of type assertions.
- Type assertions (\`as T\`) are a code smell — justify each use.

### 2.3 Zod / Runtime Validation
- If the project uses Zod (or similar), validate external inputs at boundaries.
- Infer types from schemas: \`z.infer<typeof Schema>\` instead of duplicate interfaces.
- Do NOT trust inputs from external sources (API, files, env vars) without validation.

### 2.4 Enums and Constants
- Prefer \`as const\` objects or union types over TypeScript \`enum\`.
- If the repo uses \`enum\`, follow the repo pattern.

### 2.5 Generics
- Use generics for reusable abstractions, not for every function.
- Name generic parameters descriptively for complex generics: \`TInput\`, \`TOutput\` instead of \`T\`, \`U\`.

---

## 3. Naming Conventions

Follow repo conventions when they exist. Otherwise use these defaults:

**Files and directories:**

| Type | Convention | Example |
|------|-----------|---------|
| Module | \`{feature}.ts\` (kebab-case) | \`user-service.ts\` |
| Types/interfaces | \`{feature}.ts\` or \`types.ts\` | \`types.ts\`, \`user.ts\` |
| Tests | \`{source}.test.ts\` or \`{source}.spec.ts\` | \`user-service.test.ts\` |
| Index/barrel | \`index.ts\` | \`index.ts\` |
| Constants | \`constants.ts\` or \`{feature}.constants.ts\` | \`constants.ts\` |
| Config | \`config.ts\` or \`{feature}.config.ts\` | \`config.ts\` |

**Symbols:**

| Type | Convention | Example |
|------|-----------|---------|
| Interface | PascalCase, no \`I\` prefix | \`UserService\`, \`RepoSignals\` |
| Type alias | PascalCase | \`Phase\`, \`ValidationResult\` |
| Class | PascalCase | \`ProfileRegistry\`, \`HashChain\` |
| Function | camelCase | \`resolvePolicy\`, \`createSnapshot\` |
| Constant | UPPER_SNAKE_CASE or camelCase | \`SOLO_POLICY\`, \`defaultRegistry\` |
| Variable | camelCase | \`bestScore\`, \`currentPhase\` |
| Enum member | UPPER_SNAKE_CASE (if using enum) | \`Phase.TICKET\` |
| Zod schema | PascalCase (matches inferred type) | \`SessionState\`, \`TicketEvidence\` |

**Exports:**

| Type | Convention |
|------|-----------|
| Module barrel | Named exports from \`index.ts\` |
| Default exports | Avoid unless framework requires (e.g., Next.js pages) |
| Re-exports | Explicit: \`export { X } from './x'\`, not \`export *\` |

---

## 4. Architecture Rules

### 4.1 Module Boundaries
- Respect directory-based module boundaries.
- Import through barrel exports (\`index.ts\`), not deep paths.
- No circular dependencies between modules.

### 4.2 Dependency Direction
- Dependencies flow inward: adapters -> core, not core -> adapters.
- Core business logic must not import framework-specific code.
- Side effects (I/O, network, file system) isolated at boundaries.

### 4.3 Error Handling
- Use explicit error types (discriminated unions, custom Error classes).
- Do NOT swallow errors with empty catch blocks.
- Use \`Result<T, E>\` pattern or explicit error returns for expected failures.
- Reserve \`throw\` for unexpected/unrecoverable errors.
- Async functions: always handle rejections explicitly.

### 4.4 Immutability
- Prefer \`readonly\` properties and \`ReadonlyArray\` / \`ReadonlyMap\`.
- Avoid mutation of shared state.
- Use spread/Object.assign for shallow copies; structuredClone for deep copies.

### 4.5 Async Patterns
- Use \`async/await\` over raw Promises.
- No floating promises (unhandled \`.then()\` without \`await\` or \`.catch()\`).
- Use \`Promise.all\` for concurrent independent operations.
- Timeouts on all external calls.

---

## 5. Testing Rules

### 5.1 Test Structure
- One test file per source module.
- Use \`describe\` blocks grouped by function/method.
- Test names describe behavior: \`it('returns null when input is empty')\`.
- Arrange/Act/Assert structure in every test.

### 5.2 Test Quality
- Deterministic: no real timers, no real I/O, no random values in assertions.
- Behavior-focused: test observable outputs, not implementation details.
- Meaningful assertions: no \`expect(result).toBeTruthy()\` for complex objects.
- Edge cases: empty inputs, null/undefined, boundary values, error paths.

### 5.3 Mocking
- Mock at boundaries (I/O, network, file system), not internal modules.
- Prefer dependency injection over module mocking.
- If using vi.mock/jest.mock: mock the minimal surface needed.
- Reset mocks between tests to prevent state leakage.

### 5.4 Type Testing
- If the project exports public types, test type compatibility.
- Use \`expectTypeOf\` (vitest) or \`tsd\` for type-level assertions.

---

## 6. Quality Gates (Hard Fail)

| Gate | Fail Condition |
|------|---------------|
| QG-1 Build | \`tsc --noEmit\` fails, lint errors |
| QG-2 Tests | Test suite fails, coverage regression on changed files |
| QG-3 Types | \`any\` introduced without justification, type assertions without narrowing |
| QG-4 Architecture | Circular dependencies, boundary violations, deep imports |
| QG-5 Security | Unsanitized inputs, secret exposure, unsafe eval/exec |

---

## 7. Anti-Patterns (detect and avoid)

| ID | Pattern | Why Harmful |
|----|---------|-------------|
| AP-TS01 | Pervasive \`any\` | Disables type checker, bugs slip through, refactoring becomes unsafe |
| AP-TS02 | Type Assertion Abuse | \`as T\` bypasses narrowing, hides type mismatches at runtime |
| AP-TS03 | Barrel Export Explosion | \`export *\` from deeply nested modules -> circular deps, slow builds |
| AP-TS04 | Floating Promises | Unhandled async errors, silent failures, unpredictable control flow |
| AP-TS05 | Mutable Shared State | Race conditions, test pollution, non-deterministic behavior |
| AP-TS06 | God Module | 500+ line file with mixed responsibilities -> untestable, unmaintainable |
| AP-TS07 | Console.log in Production | No structured logging, no levels, no correlation, hard to filter |
| AP-TS08 | Empty Catch Blocks | Silent error swallowing, undefined state, impossible debugging |
| AP-TS09 | Synchronous I/O | Blocks event loop, degrades throughput, masks under low load |
| AP-TS10 | Test Implementation Coupling | Tests break on refactor even when behavior unchanged |
`;

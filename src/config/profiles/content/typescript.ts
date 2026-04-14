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
- MUST NOT use \`any\` unless absolutely necessary and documented with rationale.
- MUST prefer \`unknown\` over \`any\` for untyped external data.
- MUST use type narrowing (type guards, discriminated unions) instead of type assertions.
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
- MUST use explicit error types (discriminated unions, custom Error classes).
- MUST NOT swallow errors with empty catch blocks.
- SHOULD use \`Result<T, E>\` pattern or explicit error returns for expected failures.
- Reserve \`throw\` for unexpected/unrecoverable errors.
- Async functions: MUST handle rejections explicitly.

### 4.4 Immutability
- SHOULD prefer \`readonly\` properties and \`ReadonlyArray\` / \`ReadonlyMap\`.
- MUST NOT mutate shared state.
- Use spread/Object.assign for shallow copies; structuredClone for deep copies.

### 4.5 Async Patterns
- MUST use \`async/await\` over raw Promises.
- MUST NOT leave floating promises (unhandled \`.then()\` without \`await\` or \`.catch()\`).
- SHOULD use \`Promise.all\` for concurrent independent operations.
- SHOULD add timeouts on all external calls.

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

---

## 8. Few-Shot Examples (Anti-Pattern Corrections)

<examples>
<example id="AP-TS01" type="anti-pattern">
<bad_code>
// PERVASIVE ANY — type checker disabled, bugs invisible
function processData(data: any): any {
  const result = data.items.map((item: any) => ({
    name: item.name.toUpperCase(),
    value: item.count * 2,
  }));
  return { processed: result, total: data.items.length };
}
</bad_code>
<good_code>
// Explicit types with runtime validation at boundary
interface DataItem {
  readonly name: string;
  readonly count: number;
}
interface DataInput {
  readonly items: readonly DataItem[];
}
interface DataOutput {
  readonly processed: readonly { name: string; value: number }[];
  readonly total: number;
}
function processData(data: DataInput): DataOutput {
  const processed = data.items.map((item) => ({
    name: item.name.toUpperCase(),
    value: item.count * 2,
  }));
  return { processed, total: data.items.length };
}
</good_code>
<why>\`any\` disables the type checker entirely. Property typos, wrong argument types, and structural mismatches become runtime errors instead of compile errors. Refactoring becomes unsafe because the compiler cannot track usage.</why>
</example>

<example id="AP-TS04" type="anti-pattern">
<bad_code>
// FLOATING PROMISE — unhandled async error, silent failure
function saveUser(user: User): void {
  db.insert(user).then(() => {
    cache.invalidate(user.id);
  });
  // no await, no catch — if insert fails, nobody knows
}
</bad_code>
<good_code>
// Awaited with explicit error handling
async function saveUser(user: User): Promise<void> {
  await db.insert(user);
  await cache.invalidate(user.id);
}
</good_code>
<why>Floating promises swallow errors silently. The caller believes the operation succeeded while data may be lost. Unhandled rejections crash Node.js processes in production.</why>
</example>

<example id="AP-TS08" type="anti-pattern">
<bad_code>
// EMPTY CATCH — error swallowed, state undefined
async function loadConfig(): Promise<Config> {
  try {
    const raw = await fs.readFile('config.json', 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    // silently returns undefined — caller gets unexpected type
    return {} as Config;
  }
}
</bad_code>
<good_code>
// Explicit error with meaningful context
async function loadConfig(path: string): Promise<Config> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf-8');
  } catch (cause) {
    throw new ConfigError(\`Failed to read config from \${path}\`, { cause });
  }
  try {
    return JSON.parse(raw) as Config;
  } catch (cause) {
    throw new ConfigError(\`Invalid JSON in config file \${path}\`, { cause });
  }
}
</good_code>
<why>Empty catch blocks produce undefined state that propagates silently. Callers cannot distinguish "no config" from "disk failure" from "malformed JSON". Debugging becomes impossible.</why>
</example>
</examples>

---

## 9. Minimum Negative Tests per Change Type

For every change, the following negative-path tests MUST exist:

| Change Type | MUST Test (negative path) |
|---|---|
| Function/Module | null/undefined input, empty input ([] / '' / {}), invalid type at boundary, thrown error path |
| Async Function | rejection/error propagation, timeout behavior (if applicable), concurrent call safety |
| API Boundary | malformed request body, missing required fields, unauthorized access, error response shape |
| Config/Environment | missing env var, malformed config file, invalid values |
| State Management | initial state correctness, invalid state transition, concurrent mutation |

---

## 10. Stack-Specific Review Checklist

When reviewing TypeScript changes, MUST verify:

| Check | What to look for |
|-------|-----------------|
| \`any\` Usage | New \`any\` types without documented justification, \`as any\` casts |
| Floating Promises | \`.then()\` without \`await\` or \`.catch()\`, missing \`async\` on functions that call async code |
| Circular Dependencies | Barrel re-exports creating import cycles, new cross-module imports |
| Empty Catch Blocks | \`catch (e) {}\` or \`catch { return defaultValue }\` without logging or re-throw |
| Synchronous I/O | \`fs.readFileSync\`, \`execSync\` in non-startup code paths |
| Type Assertions | \`as T\` without prior narrowing, especially \`as any\` chains |
| Mutable Shared State | Module-level \`let\` variables, objects mutated from multiple call sites |
| Test Determinism | \`Date.now()\` / \`Math.random()\` in assertions, real timers, real filesystem I/O |
`;

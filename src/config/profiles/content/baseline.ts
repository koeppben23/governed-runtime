/**
 * @module config/profiles/content/baseline
 * @description Baseline (stack-agnostic) profile rule content for LLM guidance.
 *
 * This content is injected into FlowGuard tool responses when no stack-specific
 * profile matches the repository. It supplements the universal FlowGuard mandates (flowguard-mandates.md)
 * with fundamental programming best practices that apply to any language or framework.
 *
 * Designed for: Python, Go, Rust, C#, Ruby, or any stack without a dedicated profile.
 *
 * @version v1
 */

export const profileRuleContent = `
# Baseline Profile Rules

These rules supplement the universal FlowGuard mandates. They apply when no
stack-specific profile matches the repository. They provide fundamental
programming best practices that apply to any language or framework.

---

## 1. Repo Conventions Lock

Before code changes, detect and lock:
- Primary language and version
- Build tool and build command
- Package manager and lockfile
- Test framework and test command
- Lint/format tools and commands
- Module/package structure pattern
- CI/CD pipeline (if detectable)

Once detected, these become constraints. Do not introduce new tooling or patterns
unless the change explicitly requires it.

- Mark unverified runtime claims as \`NOT_VERIFIED\`.
- Mark beliefs not checked against artifacts as \`ASSUMPTION\`.
- Include recovery or verification steps when they are actionable.

---

## 2. Code Organization

### 2.1 Single Responsibility
- Each module/file SHOULD have one clear responsibility.
- Functions SHOULD do one thing and be named for what they do.
- Classes/structs SHOULD represent one concept.

### 2.2 Module Boundaries
- Respect directory-based module boundaries.
- Import through public interfaces, not internal/private paths.
- No circular dependencies between modules.

### 2.3 Dependency Direction
- Dependencies SHOULD flow inward: adapters/infrastructure -> core/domain.
- Core business logic MUST NOT import framework-specific or I/O code.
- Side effects (I/O, network, filesystem) SHOULD be isolated at boundaries.

---

## 3. Error Handling

- MUST NOT swallow errors with empty catch/except/rescue blocks.
- MUST NOT use catch-all exception handlers without re-throwing or explicit logging.
- Use explicit error types or error returns for expected failures.
- Reserve panics/throws/exceptions for truly unexpected/unrecoverable errors.
- Every error path SHOULD produce a meaningful, actionable message.
- Async/concurrent code MUST handle errors on every branch.

---

## 4. Testing Fundamentals

### 4.1 Test Structure
- One test file per source module.
- Tests grouped by function/method under test.
- Test names MUST describe behavior, not implementation.
- Arrange/Act/Assert (Given/When/Then) structure in every test.

### 4.2 Test Quality
- Tests MUST be deterministic: no real timers, no real I/O, no random values in assertions.
- Tests MUST be behavior-focused: test observable outputs, not implementation details.
- Meaningful assertions: no bare truthy/falsy checks for complex objects.
- Edge cases MUST be covered: empty inputs, null/nil/undefined, boundary values, error paths.

### 4.3 Mocking
- Mock at boundaries (I/O, network, filesystem), not internal modules.
- Prefer dependency injection over module/monkey patching.
- Reset mocks between tests to prevent state leakage.

---

## 5. Security Basics

- MUST NOT commit secrets, credentials, or API keys to source control.
- Validate all inputs from external sources (API, files, env vars, user input).
- Sanitize outputs to prevent injection (SQL, XSS, command injection).
- Do not widen trust boundaries implicitly.
- Use parameterized queries for database access.
- Path handling: prevent path traversal, validate against allowed directories.

---

## 6. Quality Gates (Hard Fail)

| Gate | Fail Condition |
|------|---------------|
| QG-1 Build | Build/compile fails or produces new warnings |
| QG-2 Tests | Test suite fails or coverage regresses on changed files |
| QG-3 Lint | Lint/format violations introduced by the change |
| QG-4 Security | Secrets committed, unsanitized inputs, unsafe operations |
| QG-5 Architecture | Circular dependencies, boundary violations, responsibility bleed |

---

## 7. Anti-Patterns (detect and avoid)

| ID | Pattern | Why Harmful |
|----|---------|-------------|
| AP-B01 | Swallowed Errors | Silent corruption, undefined state, impossible debugging |
| AP-B02 | God Module | 500+ line file with mixed responsibilities, untestable, unmaintainable |
| AP-B03 | Mutable Shared State | Race conditions, test pollution, non-deterministic behavior |
| AP-B04 | Hard-Coded Configuration | Cannot change between environments, requires code change for config |
| AP-B05 | Test Implementation Coupling | Tests break on refactor even when behavior is unchanged |
| AP-B06 | Missing Input Validation | Security vulnerabilities, undefined behavior on malformed input |
| AP-B07 | Logging Secrets | Credentials in logs, compliance violations, security exposure |
| AP-B08 | Synchronous Blocking in Async Context | Deadlocks, throughput degradation, resource exhaustion |
| AP-B09 | Copy-Paste Duplication | Diverging behavior, multiplied bugs, maintenance burden |
| AP-B10 | Magic Numbers/Strings | Unclear intent, scattered dependencies, hard to change |
`;

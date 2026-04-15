# Contributing to FlowGuard

Thank you for your interest in contributing to FlowGuard!

## Project Overview

FlowGuard is a deterministic, fail-closed workflow engine for AI-assisted software delivery built with TypeScript. It enforces explicit phases, evidence gates, audit trails, and policy enforcement within OpenCode.

## Architecture

FlowGuard follows a Clean Architecture pattern with clear layer separation:

```
integration/  -> rails/  -> machine/  -> state/
             -> adapters/ -> discovery/, archive/, config/
```

### Key Layers

| Layer | Purpose | Rules |
|-------|---------|-------|
| `state/` | Core domain model (Zod schemas, types) | Leaf module - may import discovery/types only |
| `machine/` | State machine (topology, guards, evaluation) | Only imports state/ |
| `rails/` | Workflow orchestrators (stateless) | No integration/ imports, prefer adapter I/O |
| `adapters/` | File I/O, git, workspace management | May import config/, discovery/, archive/, state/, machine/, rails/ |
| `integration/` | OpenCode tool bindings | Entry point - may import any layer |

## Development Setup

### Prerequisites

- Node.js 18+
- Bun (recommended) or npm

### Installation

```bash
# Install dependencies
npm install

# Type check
npm run check

# Run tests
npm test

# Build
npm run build
```

## Testing

FlowGuard uses Vitest for testing. All tests must pass before submitting a PR.

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run specific test file
npm test -- src/state/state.test.ts

# Run architecture tests
npm test -- src/architecture/__tests__/dependency-rules.test.ts
```

### Test Categories

| Category | Files | Purpose |
|----------|-------|---------|
| Unit | `*.test.ts` in each module | Core logic testing |
| Architecture | `src/architecture/__tests__/` | Dependency rule verification |
| Integration | `src/integration/*.test.ts` | OpenCode tool integration |
| CLI | `src/cli/*.test.ts` | Command-line interface |
| Performance | `*.test.ts` with PERF describe | Performance regression prevention |

### Test Naming Conventions

```typescript
describe("ModuleName / Feature", () => {
  describe("Happy Path", () => {
    it("should do X when Y");
  });

  describe("Edge Cases", () => {
    it("should handle empty input");
    it("should handle null/undefined");
    it("should handle maximum size");
  });

  describe("Error Handling", () => {
    it("should throw SPECIFIC_ERROR when invalid input");
    it("should return BlockedResult when precondition fails");
  });

  describe("Performance", () => {
    it("should complete in < Xms");
  });
});
```

## Code Style

### TypeScript

- Use strict TypeScript (`"strict": true` in tsconfig.json)
- Prefer `type` over `interface` for simple type aliases
- Use Zod schemas as the source of truth for data validation
- Use `readonly` for immutable data structures

### Naming Conventions

| Element | Convention | Example |
|---------|------------|---------|
| Files | kebab-case | `session-state.ts` |
| Functions | camelCase | `executeHydrate()` |
| Classes | PascalCase | `PersistenceError` |
| Constants | SCREAMING_SNAKE | `MAX_ITERATIONS` |
| Types/Interfaces | PascalCase | `RailResult` |
| Enums | PascalCase | `Command.HYDRATE` |

### Import Organization

```typescript
// 1. Node built-ins
import * as fs from "node:fs/promises";
import * as path from "node:path";

// 2. External packages
import { z } from "zod";

// 3. FlowGuard state/machine (domain)
import type { SessionState } from "../state/schema";
import { evaluate } from "../machine/evaluate";

// 4. FlowGuard application (rails)
import { executeHydrate } from "../rails/hydrate";

// 5. FlowGuard infrastructure (adapters)
import { readState } from "../adapters/persistence";

// 6. FlowGuard config/extension
import { defaultProfileRegistry } from "../config/profile";
```

## Repository Governance

### Branch Model

- `main` is **protected** — no direct commits allowed
- All changes must go through Pull Requests
- Branch naming convention:
  - `feature/<description>` — new features
  - `fix/<description>` — bug fixes
  - `docs/<description>` — documentation updates
  - `chore/<description>` — maintenance tasks

### Conventional Commits

All commit messages must follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
<type>: <description>

[optional body]

[optional footer]
```

**Allowed types:**

| Type | Description |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation changes |
| `test` | Adding or updating tests |
| `refactor` | Code refactoring without behavior change |
| `chore` | Maintenance tasks, dependency updates |
| `perf` | Performance improvements |
| `ci` | CI/CD changes |

**Examples:**
```bash
feat: add archive verification command
fix: correct session state validation
docs: update command reference
test: add edge case for empty repository
refactor: extract validation helpers
```

### Merge Strategy

- **Preferred:** Squash and merge
- PR title must follow conventional commit format
- All CI checks must pass before merge
- At least one approval required

### CI Status Checks

The following checks must pass for a PR to be merged:

| Check | Command | Description |
|-------|---------|-------------|
| Tests | `npm test` | All 906+ tests must pass |
| Type Check | `npm run check` | TypeScript compilation |
| Build | `npm run build` | Successful compilation to dist/ |

## Pull Request Process

### 1. Before Starting

- Check existing issues and PRs
- For significant changes, open an issue first to discuss the approach

### 2. Development

```bash
# Create a feature branch
git checkout -b feature/my-feature

# Make changes
# ... write code ...

# Run tests
npm test

# Run type check
npm run check

# Run architecture tests
npm test -- src/architecture/
```

### 3. Commit Messages

See [Conventional Commits](#conventional-commits) section above.

### 4. Submit PR

- Fill out the PR template
- Link related issues
- Ensure all tests pass
- Request review from maintainers

## Architecture Rules

These rules are enforced by `src/architecture/__tests__/dependency-rules.test.ts`:

### Must Follow

1. **Leaf modules** (`state/`, `archive/types`, `discovery/types`) must not import from outer layers
2. **`machine/`** may only import from `state/`
3. **`rails/`** must not import from `integration/` (to prevent circular dependencies)
4. **`rails/`** should not import node built-ins directly (I/O is handled by adapters)

### May Use

- `rails/` may import `config/`, `audit/`, `discovery/types`, `state/`, `machine/`
- `adapters/` may import `config/`, `discovery/`, `archive/`, `state/`, `machine/`, `rails/`
- `integration/` may import any layer (entry point pattern)

## Error Handling

### Use Typed Errors

```typescript
// Good: Typed error with code
export class PersistenceError extends Error {
  readonly code: "READ_FAILED" | "WRITE_FAILED" | "SCHEMA_VALIDATION_FAILED";

  constructor(code: this["code"], message: string) {
    super(message);
    this.name = "PersistenceError";
    this.code = code;
  }
}

// Bad: Generic error
throw new Error("Something went wrong");
```

### Use Blocked Results

```typescript
// Good: Structured blocked result
export function validate(input: unknown): RailResult {
  if (!isValid(input)) {
    return {
      kind: "blocked",
      code: "INVALID_INPUT",
      reason: "Input does not match expected schema",
      recovery: ["Provide valid input matching the schema"],
    };
  }
  // ...
}
```

## Documentation

### When Adding New Features

1. Update `README.md` with new commands or options
2. Add JSDoc comments to new functions
3. Add tests for new functionality
4. Update `PRODUCT_IDENTITY.md` if product facts change

### When Changing Architecture

1. Update `AGENTS.md` if developer mandates change
2. Update architecture comments in relevant files
3. Update or add architecture tests

## Performance Guidelines

- Profile operations should complete in < 10ms for simple operations
- Heavy operations should complete in < 100ms
- Use `performance.now()` for benchmarks in tests

```typescript
describe("Performance", () => {
  it("should complete in < 10ms", () => {
    const start = performance.now();
    doOperation();
    expect(performance.now() - start).toBeLessThan(10);
  });
});
```

## Questions?

- Open an issue for bugs or feature requests
- Check existing issues before creating new ones
- Follow the code of conduct

## License

By contributing, you agree that your contributions will be licensed under the same license as the project.

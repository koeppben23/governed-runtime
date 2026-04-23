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
 * Structure: PhaseInstructions with base (always-injected) and byPhase
 * (phase-specific additions). Phase-specific content is appended to base
 * when the session is in that phase.
 *
 * @version v2
 */

import type { PhaseInstructions } from '../../profile.js';

// ─── Base Content (always injected regardless of phase) ──────────────────────

const BASE_CONTENT = `\
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

## 4. Security Basics

- MUST NOT commit secrets, credentials, or API keys to source control.
- Validate all inputs from external sources (API, files, env vars, user input).
- Sanitize outputs to prevent injection (SQL, XSS, command injection).
- Do not widen trust boundaries implicitly.
- Use parameterized queries for database access.
- Path handling: prevent path traversal, validate against allowed directories.

---

## 5. Quality Gates (Hard Fail)

| Gate | Fail Condition |
|------|---------------|
| QG-1 Build | Build/compile fails or produces new warnings |
| QG-2 Tests | Test suite fails or coverage regresses on changed files |
| QG-3 Lint | Lint/format violations introduced by the change |
| QG-4 Security | Secrets committed, unsanitized inputs, unsafe operations |
| QG-5 Architecture | Circular dependencies, boundary violations, responsibility bleed |

Quality gates are unconditional. Repository conventions and local style may
narrow implementation choices only inside passing gates. They must never
override hard-fail gates, SSOT, schemas, fail-closed behavior, or universal
mandates.

---

## 6. Verification Commands

Use repo-native verification commands first:
1. Documented CI commands (from CI config, README, or CONTRIBUTING)
2. Project build/test/lint scripts as declared in the repo
3. Framework defaults only if repo-native commands are absent

If no verification command is runnable, mark result as \`NOT_VERIFIED\`
and emit recovery steps.

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
| AP-B10 | Magic Numbers/Strings | Unclear intent, scattered dependencies, hard to change |`;

// ─── Phase-Specific Sections ─────────────────────────────────────────────────

const TESTING_FUNDAMENTALS = `\
## Testing Fundamentals

### Test Structure
- One test file per source module.
- Tests grouped by function/method under test.
- Test names MUST describe behavior, not implementation.
- Arrange/Act/Assert (Given/When/Then) structure in every test.

### Test Quality
- Tests MUST be deterministic: no real timers, no real I/O, no random values in assertions.
- Tests MUST be behavior-focused: test observable outputs, not implementation details.
- Meaningful assertions: no bare truthy/falsy checks for complex objects.
- Edge cases MUST be covered: empty inputs, null/nil/undefined, boundary values, error paths.

### Mocking
- Mock at boundaries (I/O, network, filesystem), not internal modules.
- Prefer dependency injection over module/monkey patching.
- Reset mocks between tests to prevent state leakage.`;

const FEW_SHOT_EXAMPLES = `\
## Few-Shot Examples (Anti-Pattern Corrections)

<examples>
<example id="AP-B01" type="anti-pattern">
<incorrect>
# SWALLOWED ERROR — empty catch hides failure
def load_config(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return {}  # caller cannot distinguish "empty config" from "file not found"
</incorrect>
<correct>
# Explicit error with meaningful context
def load_config(path):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        raise ConfigError(f"Config file not found: {path}")
    except json.JSONDecodeError as e:
        raise ConfigError(f"Invalid JSON in {path}: {e}")
</correct>
<why>Swallowed errors produce undefined state that propagates silently. Callers cannot distinguish "empty config" from "disk failure" from "malformed file". Debugging becomes impossible.</why>
</example>

<example id="AP-B02" type="anti-pattern">
<incorrect>
# GOD MODULE — validation, persistence, formatting, notification all in one
def process_order(raw_order):
    if not raw_order.get("items"):
        raise ValueError("empty")
    order_id = db.insert({**raw_order, "status": "pending"})
    summary = ", ".join(f"{i['name']} x{i['qty']}" for i in raw_order["items"])
    mailer.send(raw_order["email"], f"Order {order_id}: {summary}")
    return order_id
</incorrect>
<correct>
# Single responsibility per module
# order_validator.py
def validate_order(raw): ...
# order_repository.py
def persist_order(validated): ...
# order_formatter.py
def format_summary(validated): ...
# order_notification.py
def notify_created(email, order_id, summary): ...
</correct>
<why>Mixed responsibilities create coupling between unrelated concerns, make the module untestable without mocking everything, and force changes to unrelated code when one concern evolves.</why>
</example>

<example id="AP-B03" type="anti-pattern">
<incorrect>
# MUTABLE SHARED STATE — global variable modified from multiple call sites
_registry = {}

def register(name, handler):
    _registry[name] = handler

def dispatch(name, *args):
    return _registry[name](*args)

def clear():
    _registry.clear()
</incorrect>
<correct>
# Encapsulated state with controlled access
class HandlerRegistry:
    def __init__(self):
        self._handlers = {}

    def register(self, name, handler):
        self._handlers[name] = handler

    def dispatch(self, name, *args):
        if name not in self._handlers:
            raise KeyError(f"No handler registered for '{name}'")
        return self._handlers[name](*args)
</correct>
<why>Module-level mutable state creates race conditions, leaks between tests, and makes behavior non-deterministic. Encapsulation controls access and enables isolated testing.</why>
</example>

<example id="AP-B04" type="anti-pattern">
<incorrect>
# HARD-CODED CONFIGURATION — values baked into source
def connect_db():
    return create_engine("postgresql://admin:secret@prod-db:5432/myapp")
</incorrect>
<correct>
# Configuration from environment with explicit failure
def connect_db():
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise ConfigError("DATABASE_URL is required but not set")
    return create_engine(url)
</correct>
<why>Hard-coded config cannot change between environments without a code change, leaks credentials into source control, and defeats deployment automation.</why>
</example>

<example id="AP-B05" type="anti-pattern">
<incorrect>
# TEST IMPLEMENTATION COUPLING — tests mirror internal structure
def test_process_order():
    order = Order(items=[Item("A", 1)])
    order._validate()          # testing private method
    assert order._status == "validated"  # asserting private field
    order._persist(mock_db)
    assert mock_db.insert.call_args[0][0]["status"] == "validated"
</incorrect>
<correct>
# Test observable behavior, not implementation
def test_process_order_succeeds():
    result = process_order({"items": [{"name": "A", "qty": 1}]})
    assert result.order_id is not None
    assert result.status == "confirmed"
</correct>
<why>Tests coupled to private internals break on every refactor even when behavior is unchanged. They test structure instead of correctness, creating maintenance burden without confidence.</why>
</example>

<example id="AP-B06" type="anti-pattern">
<incorrect>
# MISSING INPUT VALIDATION — external data trusted blindly
def create_user(data):
    username = data["username"]
    db.execute(f"INSERT INTO users (name) VALUES ('{username}')")
    return {"id": db.last_id(), "name": username}
</incorrect>
<correct>
# Validate and sanitize external inputs
def create_user(data):
    username = data.get("username", "").strip()
    if not username or len(username) > 255:
        raise ValidationError("username must be 1-255 non-empty characters")
    db.execute("INSERT INTO users (name) VALUES (%s)", (username,))
    return {"id": db.last_id(), "name": username}
</correct>
<why>Unvalidated inputs cause injection attacks, undefined behavior on malformed data, and corrupt downstream state. Parameterized queries prevent SQL injection.</why>
</example>

<example id="AP-B07" type="anti-pattern">
<incorrect>
# LOGGING SECRETS — credentials written to log output
def authenticate(api_key):
    logger.info(f"Authenticating with key: {api_key}")
    response = requests.post(AUTH_URL, headers={"Authorization": api_key})
    logger.debug(f"Auth response: {response.json()}")
    return response.json()["token"]
</incorrect>
<correct>
# Never log any part of a secret — use opaque identifiers
def authenticate(api_key):
    logger.info("Authenticating with configured API key")
    response = requests.post(AUTH_URL, headers={"Authorization": api_key})
    logger.debug("Auth response status: %d", response.status_code)
    return response.json()["token"]
</correct>
<why>Full credentials in logs create security exposure in log aggregation, compliance violations, and credential leakage to anyone with log access.</why>
</example>

<example id="AP-B08" type="anti-pattern">
<incorrect>
# SYNCHRONOUS BLOCKING IN ASYNC CONTEXT — blocks the event loop
async def fetch_all(urls):
    results = []
    for url in urls:
        resp = requests.get(url)  # sync call inside async coroutine
        results.append(resp.json())
    return results
</incorrect>
<correct>
# Use async I/O consistently
async def fetch_all(urls):
    async with aiohttp.ClientSession() as session:
        tasks = [session.get(url) for url in urls]
        responses = await asyncio.gather(*tasks)
        return [await r.json() for r in responses]
</correct>
<why>Synchronous I/O in async context blocks the event loop, causing deadlocks, throughput degradation, and resource exhaustion under concurrent load.</why>
</example>
</examples>`;

const NEGATIVE_TEST_MATRIX = `\
## Minimum Negative Tests per Change Type

For every change, the following negative-path tests MUST exist:

| Change Type | MUST Test (negative path) |
|---|---|
| Function/Module | null/empty input, invalid type at boundary, thrown error path |
| API Boundary | malformed request, missing required fields, unauthorized access, error response shape |
| Config/Environment | missing config, malformed values, invalid defaults |
| State/Lifecycle | initial state correctness, invalid transition, concurrent mutation |`;

const REVIEW_CHECKLIST = `\
## Review Checklist

When reviewing changes, MUST verify:

| Check | What to look for |
|-------|-----------------|
| Error Handling | Swallowed errors, empty catch/except blocks, missing error propagation |
| Input Validation | Unvalidated external inputs, missing boundary checks |
| Shared State | Module-level mutable state, race conditions, test pollution |
| Test Quality | Nondeterministic tests, implementation coupling, missing edge cases |
| Security | Secrets in code/logs, unsanitized inputs, widened trust boundaries |
| Architecture | Circular dependencies, boundary violations, responsibility bleed |`;

// ─── Detected Stack Instruction ──────────────────────────────────────────────

const DETECTED_STACK_INSTRUCTION = `\
## Detected Stack

Use flowguard_status.detectedStack when present. Prefer detected tools,
frameworks, runtimes, and versions over generic defaults.
When choosing verification commands, prefer
flowguard_status.verificationCandidates when present. They are advisory
planning hints, not executed checks.
Do not make version-specific claims without repository evidence; mark
unsupported claims as NOT_VERIFIED.`;

// ─── Exported PhaseInstructions ──────────────────────────────────────────────

/**
 * Baseline profile rule content as PhaseInstructions.
 *
 * - `base`: Always-injected content (conventions, code organization, error
 *   handling, security, quality gates, anti-pattern reference table).
 * - `byPhase`: Phase-specific additions:
 *   - PLAN: detected stack + testing fundamentals + negative test matrix
 *   - PLAN_REVIEW: review checklist
 *   - IMPLEMENTATION: detected stack + testing fundamentals + examples + negative test matrix
 *   - IMPL_REVIEW: detected stack + examples + review checklist
 *   - EVIDENCE_REVIEW: review checklist
 *   - REVIEW: detected stack + examples + review checklist
 */
export const profileRuleContent: PhaseInstructions = {
  base: BASE_CONTENT,
  byPhase: {
    PLAN:
      DETECTED_STACK_INSTRUCTION +
      '\n\n---\n\n' +
      TESTING_FUNDAMENTALS +
      '\n\n---\n\n' +
      NEGATIVE_TEST_MATRIX,
    PLAN_REVIEW: REVIEW_CHECKLIST,
    IMPLEMENTATION:
      DETECTED_STACK_INSTRUCTION +
      '\n\n---\n\n' +
      TESTING_FUNDAMENTALS +
      '\n\n---\n\n' +
      FEW_SHOT_EXAMPLES +
      '\n\n---\n\n' +
      NEGATIVE_TEST_MATRIX,
    IMPL_REVIEW:
      DETECTED_STACK_INSTRUCTION +
      '\n\n---\n\n' +
      FEW_SHOT_EXAMPLES +
      '\n\n---\n\n' +
      REVIEW_CHECKLIST,
    EVIDENCE_REVIEW: REVIEW_CHECKLIST,
    REVIEW:
      DETECTED_STACK_INSTRUCTION +
      '\n\n---\n\n' +
      FEW_SHOT_EXAMPLES +
      '\n\n---\n\n' +
      REVIEW_CHECKLIST,
  },
};

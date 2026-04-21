/**
 * @module config/profiles/content/java
 * @description Java (Spring Boot) profile rule content for LLM guidance.
 *
 * This content is injected into FlowGuard tool responses when the Java
 * profile is active. It supplements the universal FlowGuard mandates (flowguard-mandates.md) with
 * Java-specific naming, architecture, testing, and anti-pattern rules.
 *
 * Structure: PhaseInstructions with base (always-injected) and byPhase
 * (phase-specific additions). Phase-specific content is appended to base
 * when the session is in that phase.
 *
 * @version v2
 */

import type { PhaseInstructions } from '../../profile';

// ─── Base Content (always injected regardless of phase) ──────────────────────

const BASE_CONTENT = `\
# Java (Spring Boot) Profile Rules

These rules supplement the universal FlowGuard mandates. They apply when the
FlowGuard system detects a Java/Spring Boot stack in the repository.

---

## 1. Technology Stack Detection

Do not assume Java, Spring Boot, or build tool versions.
Detect stack facts from repository evidence first:
- Java version from \`.java-version\`, \`pom.xml\`, \`build.gradle\`, or CI config
- Spring Boot version from \`pom.xml\`/\`build.gradle\` dependency declarations
- Build tool from \`mvnw\`/\`gradlew\` wrapper presence or manifest files

Version-specific guidance requires repository evidence.
If the version cannot be verified, mark version-specific claims as \`NOT_VERIFIED\`.

Detect-if-present (no version assumption needed):
- JPA/Hibernate, Liquibase/Flyway, OpenAPI Generator
- MapStruct / Lombok, Actuator + Micrometer, Spring Security

**Repo-first rule:** If a tool exists in the repo and is runnable, it is not optional — execute it and capture evidence. If not runnable, mark claims as \`NOT_VERIFIED\` and emit recovery commands.

## 2. Repo Conventions Lock

Before producing code, detect and lock the repo conventions:
- Build tool + module selection (mvnw/gradlew, multi-module flags)
- Web stack (Spring MVC vs WebFlux), serialization (Jackson settings)
- Error contract (problem+json / custom envelope / codes)
- Validation approach (jakarta validation + @Validated, custom validators)
- Test stack (JUnit5/JUnit4, AssertJ/Hamcrest, Mockito, Testcontainers, WireMock)
- Formatting/lint gates (Spotless/Checkstyle/PMD/SpotBugs/ErrorProne/Sonar)

Once detected, these conventions become constraints. If not detectable, mark as unknown and avoid introducing new patterns.

- Mark unverified runtime claims as \`NOT_VERIFIED\`.
- Mark beliefs not checked against artifacts as \`ASSUMPTION\`.
- Include recovery or verification steps when they are actionable.

---

## 3. Code Style & Determinism

### 3.1 Style
- Follow repo style; default to Google Java Style if ambiguous.
- No wildcard imports. No production TODO/FIXME without explicit approval.

### 3.2 Nullability
- Non-null by default. \`Optional\` only for return values.

### 3.3 Time & Randomness
- Inject \`Clock\`. Seed randomness in tests. No sleeps; use Awaitility if async.

### 3.4 Dependency Injection & Immutability
- Constructor injection only (no field injection).
- Prefer immutable objects: \`final\` fields, no setter-based mutation.
- DTOs: prefer \`record\` if repo uses records; otherwise follow repo pattern.
- Lombok: do NOT use \`@Data\` on domain/entities.
- No \`Optional\` as parameter/field.

### 3.5 Forbidden Patterns
Not allowed in generated production code unless repo already uses them:
- Business branching inside controllers/adapters
- Returning JPA entities from controllers
- Catching \`Exception\` / swallowing exceptions / logging-only error handling
- Introducing new framework patterns without repo evidence
- Commented-out code or TODO/FIXME without approval

---

## 4. Naming Conventions

Follow repo conventions when they exist. Otherwise use these defaults:

**Classes:**

| Type | Convention | Example |
|------|-----------|---------|
| Controller | \`{Resource}Controller\` | \`UserController\` |
| Service | \`{Resource}Service\` | \`UserService\` |
| Repository | \`{Resource}Repository\` | \`UserRepository\` |
| Entity | \`{Resource}\` (singular, PascalCase) | \`User\`, \`Order\` |
| DTO (request) | \`{Resource}CreateRequest\`, \`{Resource}UpdateRequest\` | \`UserCreateRequest\` |
| DTO (response) | \`{Resource}Response\` | \`UserResponse\` |
| Mapper | \`{Resource}Mapper\` | \`UserMapper\` |
| Exception | \`{Resource}NotFoundException\`, \`{Domain}Exception\` | \`UserNotFoundException\` |
| Config | \`{Feature}Config\`, \`{Feature}Properties\` | \`SecurityConfig\` |

**Methods:**

| Type | Convention | Example |
|------|-----------|---------|
| Create | \`create({Resource})\` | \`create(user)\` |
| Find | \`findById(id)\`, \`findAll(...)\` | \`findById(1L)\` |
| Update | \`update(id, {Resource})\` | \`update(1L, user)\` |
| Delete | \`delete(id)\` | \`delete(1L)\` |
| Domain validation | \`validate()\`, \`validateCanBe{Action}()\` | \`validateCanBeDeleted()\` |
| Mapper | \`toDomain(request)\`, \`toResponse({resource})\` | \`toDomain(createRequest)\` |

**Tests:**

| Type | Convention | Example |
|------|-----------|---------|
| Test class | \`{ClassUnderTest}Test\` | \`UserServiceTest\` |
| Test method | \`{method}_{condition}_{expected}\` | \`create_withValidInput_persistsUser()\` |
| Test builder | \`{Resource}TestDataBuilder\` with \`given{Resource}()\` | \`givenUser()\` |
| Nested class | Method name (PascalCase) | \`class Create { }\` |

**Packages:**

| Type | Convention | Example |
|------|-----------|---------|
| Feature root | \`com.company.{app}.{feature}\` | \`com.acme.shop.order\` |
| Controller | \`{feature}.api\` or \`{feature}.controller\` | \`order.api\` |
| Service | \`{feature}.service\` or \`{feature}.application\` | \`order.service\` |
| Domain | \`{feature}.domain\` or \`{feature}.model\` | \`order.domain\` |
| Repository | \`{feature}.repository\` or \`{feature}.persistence\` | \`order.repository\` |

---

## 5. Architecture Rules

### 5.1 Architecture Detection
Detect and lock the repo architecture pattern:
- Feature-modular layered, Classic layered, or Hexagonal (ports & adapters)

Once detected, do not mix patterns within a change.

### 5.2 Controllers
Controllers MUST: validate input, map DTOs, delegate, handle HTTP concerns.
Controllers MUST NOT: contain business branching, persistence logic, or transaction management.

### 5.3 Services
Services MUST represent use cases, not entities. No god services. Domain invariants MUST be enforced in business logic, not scattered across layers.

### 5.4 Transactions
One transaction per use case. MUST NOT make external calls inside DB transactions unless compensated. Idempotency MUST be ensured for external triggers.

### 5.5 Persistence Hygiene (if JPA present)
- Prevent lazy-loading leaks across boundaries.
- Avoid N+1 queries (use fetch joins/entity graphs).
- \`@Transactional(readOnly = true)\` for read use cases.
- Optimistic locking (\`@Version\`) for concurrent aggregate updates.
- Map persistence models to boundary DTOs (no entity exposure).

---

## 6. Contracts & Code Generation

If OpenAPI/Pact exists, contract MUST be treated as authoritative. Code MUST adapt
to the contract, never the reverse. Generated code MUST NOT be edited. Business logic
MUST NOT be placed in generated packages. Treat generated code as boundary. Map DTOs
explicitly.

Contract drift -> hard failure. No bypass without documented exception.

---

## 7. Error Handling

- Centralized error mapping (\`@ControllerAdvice\`). Stable error codes. No internal leakage.
- Use RFC7807 if repo uses it.
- For changed endpoints: assert HTTP status + stable error code in tests.

---

## 8. Quality Gates (Hard Fail)

A change fails if any of these apply:

| Gate | Fail Condition |
|------|---------------|
| QG-1 Build | Build not green, static analysis regressions |
| QG-2 Contract | Contract drift, edited generated code, missing regeneration |
| QG-3 Architecture | Layer/module violations, fat controllers |
| QG-4 Test Quality | Missing behavioral coverage, flaky tests, missing determinism seams, missing concurrency evidence |
| QG-5 Operational | Logging/metrics/tracing/security regression |

Quality gates are unconditional. Repository conventions and local style may
narrow implementation choices only inside passing gates. They must never
override hard-fail gates, SSOT, schemas, fail-closed behavior, or universal
mandates.

---

## 9. Verification Commands

Use repo-native verification commands first:
1. Documented CI commands (from CI config, README, or CONTRIBUTING)
2. Project scripts (mvnw/gradlew targets, Maven/Gradle wrapper)
3. Framework defaults (\`mvn verify\`, \`gradle check\`) only if repo-native absent

If no verification command is runnable, mark result as \`NOT_VERIFIED\`
and emit recovery steps.

---

## 10. Anti-Patterns (detect and avoid)

| ID | Pattern | Why Harmful |
|----|---------|-------------|
| AP-J01 | Fat Controller | Business logic in controller -> untestable without HTTP context, logic duplication |
| AP-J02 | Anemic Domain | Entities are pure data holders -> invariants scattered, inconsistent enforcement |
| AP-J03 | Nondeterministic Tests | \`Instant.now()\`, \`Thread.sleep()\`, random UUIDs -> flaky, unreproducible |
| AP-J04 | Entity Exposure | JPA entities returned from controllers -> persistence schema leaks to API |
| AP-J05 | Swallowed Exceptions | catch-log-ignore -> silent corruption, undefined state |
| AP-J06 | God Service | 10+ methods spanning unrelated use cases -> SRP violation, untestable |
| AP-J07 | Field Injection | \`@Autowired\` on fields -> hidden deps, harder testing, masked coupling |
| AP-J08 | Test Overspecification | verify(mock, times(1)) without behavioral assertion -> breaks on refactor |
| AP-J09 | Transaction Boundary Leak | External calls inside @Transactional -> connection pool exhaustion, inconsistency |
| AP-J10 | Mutable DTO | Public setters on domain objects -> impossible invariant enforcement |`;

// ─── Phase-Specific Sections ─────────────────────────────────────────────────

const DECISION_TREES = `\
## Architecture Decision Trees

### Architecture Pattern Selection

When creating a new module from scratch:
\`\`\`
Does the repo have an established pattern?
  YES -> Follow detected pattern. STOP.
  NO  -> Is it API-driven with external consumers?
    YES -> Complex domain logic (>3 business rules)? -> Hexagonal
           Simple delegation? -> Classic layered
    NO  -> Event-driven/messaging? -> Hexagonal
           Multi-feature service? -> Feature-modular layered
\`\`\`

### Test Type Selection

For each changed component:
\`\`\`
Controller/API  -> Slice test (@WebMvcTest): HTTP mapping, status, serialization, errors
                   Contract test: only if external consumers exist
Service/UseCase -> Unit test: business logic with mocked deps (no @SpringBootTest)
                   Integration: only if orchestrating multiple repos with @Transactional
Repository      -> Slice test (@DataJpaTest): queries, constraints, mappings
                   Include: happy + constraint violation + empty result
Domain entity   -> Unit test: invariants, business methods, equality
                   Include: valid + invalid construction + state transitions
Config/Infra    -> Integration test: verify wiring. Startup smoke test if new beans.
Security        -> Slice test: @WithMockUser + @WebMvcTest
\`\`\``;

const TESTING_RULES = `\
## Testing Rules

### Test Pyramid
1. Unit (business logic, no Spring) 2. Slice (web/persistence) 3. Integration (if risk requires) 4. E2E/BDD (only if established)

### Behavioral Coverage Matrix
For changed public behavior, cover:
HAPPY_PATH, VALIDATION, NOT_FOUND/EMPTY, STATE_INVALID, AUTHORIZATION, BOUNDARIES, DB_CONSTRAINTS, ASYNC (if applicable)

### Test Quality Rules
- Deterministic. Behavior-focused. No overspecification. No flakiness.
- Time: injectable \`Clock\` with fixed instant in tests.
- IDs: no random identifiers in assertions.
- Order: no order-dependent assertions unless order is contractual.
- Use Given/When/Then consistently. Assert outcomes over interactions.
- Parameterized tests for boundary sets. Test data builders for readability.`;

const FEW_SHOT_EXAMPLES = `\
## Few-Shot Examples (Anti-Pattern Corrections)

<examples>
<example id="AP-J01" type="anti-pattern">
<incorrect>
// FAT CONTROLLER — business logic in controller
@PostMapping("/orders")
public ResponseEntity<Order> createOrder(@RequestBody OrderRequest req) {
    if (req.getItems().isEmpty()) {
        throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "No items");
    }
    double total = 0;
    for (var item : req.getItems()) {
        var product = productRepo.findById(item.getProductId()).orElseThrow();
        total += product.getPrice() * item.getQuantity();
        if (product.getStock() < item.getQuantity()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Out of stock");
        }
        product.setStock(product.getStock() - item.getQuantity());
        productRepo.save(product);
    }
    var order = new Order();
    order.setTotal(total);
    order.setItems(req.getItems());
    return ResponseEntity.status(201).body(orderRepo.save(order));
}
</incorrect>
<correct>
// Controller delegates to service, maps DTOs at boundary
@PostMapping("/orders")
public ResponseEntity<OrderResponse> createOrder(@Valid @RequestBody OrderCreateRequest req) {
    Order order = orderService.create(orderMapper.toDomain(req));
    return ResponseEntity.status(HttpStatus.CREATED).body(orderMapper.toResponse(order));
}
</correct>
<why>Business rules in controllers are untestable without HTTP context, violate SRP, and scatter domain logic across layers.</why>
</example>

<example id="AP-J03" type="anti-pattern">
<incorrect>
// NONDETERMINISTIC TEST — Instant.now() produces different values on each run
@Test
void create_setsCreatedTimestamp() {
    var user = userService.create(new UserCreateRequest("Alice"));
    assertThat(user.getCreatedAt()).isBeforeOrEqualTo(Instant.now());
}
</incorrect>
<correct>
// Deterministic via injected Clock
@Test
void create_setsCreatedTimestamp() {
    var fixedInstant = Instant.parse("2024-01-15T10:00:00Z");
    var clock = Clock.fixed(fixedInstant, ZoneOffset.UTC);
    var service = new UserService(userRepository, clock);

    var user = service.create(new UserCreateRequest("Alice"));
    assertThat(user.getCreatedAt()).isEqualTo(fixedInstant);
}
</correct>
<why>Tests using Instant.now() or UUID.randomUUID() in assertions are non-reproducible. Failures depend on execution speed and cannot be debugged from the test report alone.</why>
</example>

<example id="AP-J04" type="anti-pattern">
<incorrect>
// ENTITY EXPOSURE — JPA entity returned from controller
@GetMapping("/users/{id}")
public User getUser(@PathVariable Long id) {
    return userRepository.findById(id)
        .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
}
</incorrect>
<correct>
// Boundary DTO separates persistence schema from API contract
@GetMapping("/users/{id}")
public UserResponse getUser(@PathVariable Long id) {
    User user = userService.findById(id);
    return userMapper.toResponse(user);
}
</correct>
<why>Exposing JPA entities couples API consumers to the persistence schema. Any column rename, lazy-loading change, or @JsonIgnore slip leaks internal structure.</why>
</example>

<example id="AP-J05" type="anti-pattern">
<incorrect>
// SWALLOWED EXCEPTION — catch-log-ignore
public Optional<User> findUser(Long id) {
    try {
        return Optional.of(userRepository.findById(id).orElseThrow());
    } catch (Exception e) {
        log.error("Error finding user", e);
        return Optional.empty();
    }
}
</incorrect>
<correct>
// Explicit error handling — let expected failures propagate with domain meaning
public User findById(Long id) {
    return userRepository.findById(id)
        .orElseThrow(() -> new UserNotFoundException(id));
}
</correct>
<why>Catching Exception and returning empty hides failures, masks bugs, and produces silent data corruption. Callers cannot distinguish "not found" from "database down".</why>
</example>

<example id="AP-J07" type="anti-pattern">
<incorrect>
// FIELD INJECTION — hidden dependencies, untestable without Spring context
@Service
public class OrderService {
    @Autowired
    private OrderRepository orderRepository;
    @Autowired
    private PaymentGateway paymentGateway;

    public Order create(OrderCreateRequest request) { /* ... */ }
}
</incorrect>
<correct>
// Constructor injection — explicit, testable, immutable
@Service
public class OrderService {
    private final OrderRepository orderRepository;
    private final PaymentGateway paymentGateway;

    OrderService(OrderRepository orderRepository, PaymentGateway paymentGateway) {
        this.orderRepository = orderRepository;
        this.paymentGateway = paymentGateway;
    }

    public Order create(OrderCreateRequest request) { /* ... */ }
}
</correct>
<why>Field injection hides dependencies, prevents compile-time verification of required dependencies, and requires a full Spring context for unit testing instead of simple constructor calls.</why>
</example>

<example id="AP-J08" type="anti-pattern">
<incorrect>
// TEST OVERSPECIFICATION — verifying interactions instead of outcomes
@Test
void create_persistsUser() {
    var request = new UserCreateRequest("Alice");
    userService.create(request);
    verify(userRepository, times(1)).save(any(User.class));
    verify(eventPublisher, times(1)).publish(any(UserCreatedEvent.class));
    verifyNoMoreInteractions(userRepository, eventPublisher);
}
</incorrect>
<correct>
// Assert behavioral outcome, not interaction sequence
@Test
void create_withValidInput_persistsAndReturnsUser() {
    var request = new UserCreateRequest("Alice");
    var result = userService.create(request);
    assertThat(result.getName()).isEqualTo("Alice");
    assertThat(result.getId()).isNotNull();
    assertThat(userRepository.findById(result.getId())).isPresent();
}
</correct>
<why>Verifying exact mock interactions couples tests to implementation sequence. Any change to how persistence works (batching, caching, method rename) breaks tests even when behavior is correct.</why>
</example>

<example id="AP-J09" type="anti-pattern">
<incorrect>
// TRANSACTION BOUNDARY LEAK — business logic spans implicit transaction
public void transferFunds(Long fromId, Long toId, BigDecimal amount) {
    Account from = accountRepo.findById(fromId).orElseThrow();
    Account to = accountRepo.findById(toId).orElseThrow();
    from.debit(amount);
    accountRepo.save(from);   // committed
    // crash here leaves 'to' uncredited
    to.credit(amount);
    accountRepo.save(to);     // separate implicit transaction
}
</incorrect>
<correct>
// Explicit transaction boundary wraps the full unit of work
@Transactional
public void transferFunds(Long fromId, Long toId, BigDecimal amount) {
    Account from = accountRepo.findById(fromId).orElseThrow();
    Account to = accountRepo.findById(toId).orElseThrow();
    from.debit(amount);
    to.credit(amount);
    // both saves in same transaction — atomic commit or full rollback
}
</correct>
<why>Without an explicit transaction boundary, partial writes corrupt data on failure. The debit succeeds but the credit may not, leaving the system in an inconsistent state that is difficult to detect and recover from.</why>
</example>
</examples>`;

const EVIDENCE_BY_CHANGE_TYPE = `\
## Evidence by Change Type

| Change Type | Required Evidence |
|-------------|-------------------|
| API/Controller | tests covering HTTP contract + error contract + security (if present) |
| Persistence/Migration | migration validation + happy + violation tests for constraints |
| Messaging | consumer idempotency/retry tests + schema validation (if exists) |
| Pure Service | unit tests proving rules + slice/integration if boundary changed |`;

const NEGATIVE_TEST_MATRIX = `\
## Minimum Negative Tests per Change Type

For every change, the following negative-path tests MUST exist:

| Change Type | MUST Test (negative path) |
|---|---|
| Controller/API | invalid input -> 400, missing/invalid auth -> 401/403, resource not found -> 404, constraint violation -> 409 |
| Service | null/empty input, business rule violation, concurrent modification (if applicable) |
| Repository | unique constraint violation, empty result set, orphan reference (FK violation) |
| Domain Entity | invalid construction (missing required fields), illegal state transition, invariant violation |
| Migration | rollback script executes without error, data integrity preserved after up+down |`;

const REVIEW_CHECKLIST = `\
## Stack-Specific Review Checklist

When reviewing Java changes, MUST verify:

| Check | What to look for |
|-------|-----------------|
| N+1 Queries | \`findById\` inside loops, missing \`@EntityGraph\` or fetch joins for collections |
| Transaction Boundaries | External HTTP/messaging calls inside \`@Transactional\`, missing \`readOnly = true\` for reads |
| Entity Exposure | JPA entities in controller return types or request bodies |
| Lombok Misuse | \`@Data\` on entities (generates equals/hashCode on mutable fields), \`@AllArgsConstructor\` on beans |
| Constructor Injection | Field injection (\`@Autowired\` on fields) instead of constructor injection |
| Exception Handling | Empty catch blocks, catching \`Exception\` instead of specific types, log-only handling |
| Concurrency | Missing \`@Version\` on aggregates with concurrent writes, shared mutable state in singletons |
| Test Determinism | \`Instant.now()\` / \`UUID.randomUUID()\` in assertions, \`Thread.sleep()\` in tests |`;

// ─── Detected Stack Instruction ──────────────────────────────────────────────

const DETECTED_STACK_INSTRUCTION = `\
## Detected Stack

Use flowguard_status.detectedStack when present. Prefer detected tools,
frameworks, runtimes, and versions over generic defaults. Do not make
version-specific claims without repository evidence; mark unsupported
claims as NOT_VERIFIED.`;

// ─── Exported PhaseInstructions ──────────────────────────────────────────────

/**
 * Java profile rule content as PhaseInstructions.
 *
 * - `base`: Always-injected content (stack defaults, conventions, style,
 *   naming, architecture, contracts, error handling, quality gates,
 *   anti-pattern reference table).
 * - `byPhase`: Phase-specific additions:
 *   - PLAN: detected stack + decision trees + testing rules + evidence matrix + negative tests
 *   - PLAN_REVIEW: review checklist
 *   - IMPLEMENTATION: detected stack + testing rules + examples + evidence matrix + negative tests
 *   - IMPL_REVIEW: detected stack + examples + review checklist
 *   - EVIDENCE_REVIEW: review checklist
 *   - REVIEW: detected stack + examples + review checklist
 *   - ARCHITECTURE: decision trees
 *   - ARCH_REVIEW: decision trees + review checklist
 */
export const profileRuleContent: PhaseInstructions = {
  base: BASE_CONTENT,
  byPhase: {
    PLAN:
      DETECTED_STACK_INSTRUCTION +
      '\n\n---\n\n' +
      DECISION_TREES +
      '\n\n---\n\n' +
      TESTING_RULES +
      '\n\n---\n\n' +
      EVIDENCE_BY_CHANGE_TYPE +
      '\n\n---\n\n' +
      NEGATIVE_TEST_MATRIX,
    PLAN_REVIEW: REVIEW_CHECKLIST,
    IMPLEMENTATION:
      DETECTED_STACK_INSTRUCTION +
      '\n\n---\n\n' +
      TESTING_RULES +
      '\n\n---\n\n' +
      FEW_SHOT_EXAMPLES +
      '\n\n---\n\n' +
      EVIDENCE_BY_CHANGE_TYPE +
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
    ARCHITECTURE: DECISION_TREES,
    ARCH_REVIEW: DECISION_TREES + '\n\n---\n\n' + REVIEW_CHECKLIST,
  },
};

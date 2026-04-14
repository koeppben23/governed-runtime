/**
 * @module config/profiles/content/java
 * @description Java (Spring Boot) profile rule content for LLM guidance.
 *
 * This content is injected into governance tool responses when the Java
 * profile is active. It supplements the universal AGENTS.md mandates with
 * Java-specific naming, architecture, testing, and anti-pattern rules.
 *
 * Ported from: governance_content/profiles/rules.backend-java.md (v2.2)
 * Adapted for: TypeScript governance system, LLM-agnostic delivery
 *
 * @version v1
 */

export const profileRuleContent = `
# Java (Spring Boot) Profile Rules

These rules supplement the universal governance mandates. They apply when the
governance system detects a Java/Spring Boot stack in the repository.

---

## 1. Technology Stack Defaults

Unless repository evidence says otherwise, assume:
- Java 21, Spring Boot 3.x, Maven (Gradle only if repo uses it)
- JPA/Hibernate, Liquibase/Flyway, OpenAPI Generator (if present)
- MapStruct / Lombok, Actuator + Micrometer, Spring Security (if present)

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

### 5.2 Architecture Pattern Selection

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

### 5.3 Test Type Selection

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
\`\`\`

### 5.4 Controllers
Controllers must: validate input, map DTOs, delegate, handle HTTP concerns.
Forbidden: business branching, persistence logic, transaction management.

### 5.5 Services
Services represent use cases, not entities. No god services. Domain invariants enforced in business logic.

### 5.6 Transactions
One transaction per use case. No external calls inside DB transactions unless compensated. Idempotency required for external triggers.

### 5.7 Persistence Hygiene (if JPA present)
- Prevent lazy-loading leaks across boundaries.
- Avoid N+1 queries (use fetch joins/entity graphs).
- \`@Transactional(readOnly = true)\` for read use cases.
- Optimistic locking (\`@Version\`) for concurrent aggregate updates.
- Map persistence models to boundary DTOs (no entity exposure).

---

## 6. Contracts & Code Generation

If OpenAPI/Pact exists:
- Contract is authoritative. Code adapts to contract, never the reverse.
- NEVER edit generated code. NEVER place business logic in generated packages.
- Treat generated code as boundary. Map DTOs explicitly.

Contract drift -> hard failure. No bypass without documented exception.

---

## 7. Error Handling

- Centralized error mapping (\`@ControllerAdvice\`). Stable error codes. No internal leakage.
- Use RFC7807 if repo uses it.
- For changed endpoints: assert HTTP status + stable error code in tests.

---

## 8. Testing Rules

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
- Parameterized tests for boundary sets. Test data builders for readability.

---

## 9. Quality Gates (Hard Fail)

A change fails if any of these apply:

| Gate | Fail Condition |
|------|---------------|
| QG-1 Build | Build not green, static analysis regressions |
| QG-2 Contract | Contract drift, edited generated code, missing regeneration |
| QG-3 Architecture | Layer/module violations, fat controllers |
| QG-4 Test Quality | Missing behavioral coverage, flaky tests, missing determinism seams, missing concurrency evidence |
| QG-5 Operational | Logging/metrics/tracing/security regression |

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
| AP-J10 | Mutable DTO | Public setters on domain objects -> impossible invariant enforcement |

---

## 11. Evidence by Change Type

| Change Type | Required Evidence |
|-------------|-------------------|
| API/Controller | tests covering HTTP contract + error contract + security (if present) |
| Persistence/Migration | migration validation + happy + violation tests for constraints |
| Messaging | consumer idempotency/retry tests + schema validation (if exists) |
| Pure Service | unit tests proving rules + slice/integration if boundary changed |
`;

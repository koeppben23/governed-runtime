/**
 * @module config/profiles/content/angular
 * @description Angular + Nx profile rule content for LLM guidance.
 *
 * This content is injected into governance tool responses when the Angular
 * profile is active. It supplements the universal AGENTS.md mandates with
 * Angular-specific naming, architecture, testing, and anti-pattern rules.
 *
 * Ported from: governance_content/profiles/rules.frontend-angular-nx.md (v2.0)
 * Adapted for: TypeScript governance system, LLM-agnostic delivery
 *
 * @version v1
 */

export const profileRuleContent = `
# Angular + Nx Profile Rules

These rules supplement the universal governance mandates. They apply when the
governance system detects an Angular + Nx stack in the repository.

---

## 1. Repo Conventions Lock

Before code changes, detect and lock:
- Angular major version and standalone vs NgModule convention
- State pattern (signals/store/component-store/ngrx) and selector style
- HTTP/data-access pattern (direct HttpClient vs generated API client)
- Form strategy (typed reactive forms, validators, error rendering)
- Testing stack (Jest/Karma, Testing Library, Cypress/Playwright)
- Styling pattern (SCSS/CSS/Tailwind/design-system primitives)
- Nx project boundaries and tag constraints

Once detected, these become constraints. If unknown, mark unknown and avoid introducing a new pattern.

---

## 2. Decision Trees

### State Management Selection

\`\`\`
Does the repo already use a state management pattern?
  YES -> Follow detected pattern (signals/NgRx/component-store). STOP.
  NO  -> Is the state local to a single component?
    YES -> Simple UI state? -> Component-local signals/properties
           Complex local state? -> Component Store
    NO  -> Shared across features?
      YES -> Complex async flows? -> NgRx Store
             Simple shared state? -> Signals-based facade service
      NO  -> Clarify scope before proceeding.
\`\`\`

### Test Type Selection

\`\`\`
Container/Smart component -> Unit test (TestBed): delegation to facade/store
                             Test template bindings. Mock all injected services.
Presentational component  -> Unit test (TestBed): input/output behavior
                             Default rendering, input variations, event emission.
Facade/Store/State        -> Unit test: state transitions, selectors, effects
                             NgRx: reducer + selectors + effects separately.
API boundary service      -> Unit test: request construction, response mapping, errors
                             Mock HttpClient.
Guard/Interceptor         -> Unit test: routing decisions, request transformation
                             Allowed, denied, redirect scenarios.
Pipe/Directive            -> Unit test: transform logic, host component test
E2E (if established)      -> Critical user journeys only. Stable selectors.
\`\`\`

### Library Type Selection (Nx)

\`\`\`
UI components (shared) -> libs/shared/ui/{name}  tags: type:ui, scope:shared
                          Presentational only. Must NOT import feature/data-access.
Data access            -> libs/{domain}/data-access  tags: type:data-access, scope:{domain}
                          Services, facades, stores, models, API clients.
Feature (routed page)  -> libs/{domain}/feature-{name}  tags: type:feature, scope:{domain}
                          Container components, routing. May import data-access + ui.
Pure utility           -> libs/shared/util/{name}  tags: type:util, scope:shared
                          Pure functions. No Angular deps if possible.
Existing library?      -> Add to it. Do NOT create a new one.
\`\`\`

### Component Type Decision

\`\`\`
Manages state/orchestrates? -> Container (smart): inject facade, delegate logic.
Renders based on inputs?    -> Presentational (dumb): @Input/@Output, OnPush.
Is a form?                  -> Form component: typed reactive forms, validators separate.
Layout/structural?          -> Layout component: minimal logic, ng-content projection.
\`\`\`

---

## 3. Naming Conventions

Follow repo conventions when they exist. Otherwise use these defaults:

**Files:**

| Type | Convention | Example |
|------|-----------|---------|
| Component | \`{feature}-{type}.component.ts\` | \`user-page.component.ts\` |
| Facade | \`{feature}.facade.ts\` | \`user.facade.ts\` |
| API boundary | \`{feature}.api.ts\` | \`user.api.ts\` |
| NgRx | \`{feature}.actions.ts\`, \`.reducer.ts\`, \`.effects.ts\`, \`.selectors.ts\` | \`user.actions.ts\` |
| Component Store | \`{feature}.store.ts\` | \`user.store.ts\` |
| Guard | \`{feature}.guard.ts\` | \`auth.guard.ts\` |
| Interceptor | \`{feature}.interceptor.ts\` | \`auth.interceptor.ts\` |
| Model | \`{feature}.model.ts\` | \`user.model.ts\` |
| Test | \`{source-file}.spec.ts\` | \`user.facade.spec.ts\` |

**Classes:**

| Type | Convention | Example |
|------|-----------|---------|
| Container | \`{Feature}PageComponent\` | \`UserPageComponent\` |
| Presentational | \`{Feature}ViewComponent\`, \`{Feature}ListComponent\` | \`UserViewComponent\` |
| Facade | \`{Feature}Facade\` | \`UserFacade\` |
| API service | \`{Feature}Api\` | \`UserApi\` |
| Component Store | \`{Feature}Store\` | \`UserStore\` |
| Guard function | \`{feature}Guard\` | \`authGuard\` |
| View model | \`{Feature}ViewModel\` | \`UserViewModel\` |
| State interface | \`{Feature}State\` | \`UserState\` |

**Selectors:** \`app-{feature}-{type}\` (e.g., \`app-user-page\`)

**Methods:**

| Type | Convention | Example |
|------|-----------|---------|
| Event handler | \`on{Action}()\` | \`onRefresh()\`, \`onSubmit()\` |
| View model | \`vm\` (signal) or \`vm$\` (observable) | \`readonly vm = this.facade.vm\` |
| NgRx selectors | \`select{Feature}{Property}\` | \`selectUserItems\` |
| Store updater | \`set{Property}\` | \`setLoading\` |
| Store effect | \`load{Feature}s\` | \`loadUsers\` |

**Nx libraries:**

| Type | Convention |
|------|-----------|
| Feature | \`libs/{domain}/feature-{name}\` |
| Data access | \`libs/{domain}/data-access\` |
| UI | \`libs/{domain}/ui\` |
| Util | \`libs/{domain}/util\` or \`libs/shared/util-{name}\` |

---

## 4. Architecture and Boundaries

- Respect \`apps/*\` vs \`libs/*\` layering and tag constraints.
- Shared code belongs in \`libs/*\`; avoid app-to-app leakage.
- Use workspace aliases; avoid deep relative imports.
- New capability: implement as feature/data-access/ui libraries, not app-local sprawl.

---

## 5. Implementation Standards

### Components
- Keep focused: presentational vs container responsibilities.
- No heavy computation in templates.
- Use explicit inputs/outputs and typed view models.

### Change Detection & Reactivity
- Preserve repo default strategy. Use deterministic reactive composition.
- No nested subscriptions. Use \`async\` pipe, signals, or repo-standard teardown.

### Forms
- Use repo form pattern (typed reactive forms if present).
- Validation messages must be predictable and testable.

### API Boundaries
- Keep transport DTOs at boundaries. Map to view/domain models.
- Do NOT leak raw backend payload shapes through UI layers.

### Security
- No secrets/PII in logs. Safe HTML binding (XSS-aware). Preserve CSP.

---

## 6. Testing Rules

### Unit/Component Tests
- Deterministic and behavior-focused.
- Test user-visible outcomes over implementation internals.
- No low-signal assertions (\`truthy\`/snapshot spam).

### Integration Tests
- Cover state transitions, async boundaries, form/validation behavior.
- Mock only external edges.

### E2E (if established)
- Critical user journeys. Stable selectors (\`data-testid\`). No fixed sleeps.

---

## 7. Quality Gates (Hard Fail)

| Gate | Fail Condition |
|------|---------------|
| FQG-1 Build/Lint | affected build/lint fails |
| FQG-2 Boundary | Nx/project boundary violations |
| FQG-3 Test Quality | missing deterministic tests, flaky async, missing negative-path |
| FQG-4 Contract | contract/client drift, edited generated code |
| FQG-5 A11y/UX | obvious a11y regressions (roles/labels/focus/keyboard) |

---

## 8. Anti-Patterns (detect and avoid)

| ID | Pattern | Why Harmful |
|----|---------|-------------|
| AP-NG01 | Business Logic in Components | Untestable without TestBed, not reusable from non-UI contexts |
| AP-NG02 | Mixed State Architectures | Two mental models, sync bugs, doubled test surface |
| AP-NG03 | Direct HttpClient in Components | Scattered API knowledge, expensive testing, broken on API changes |
| AP-NG04 | Leaked Backend DTOs in UI | Couples UI to backend structure, brittle tests |
| AP-NG05 | Nested Subscriptions | Memory leaks, unpredictable errors, race conditions |
| AP-NG06 | Fixed Waits in Tests | Flaky on slow CI, slow execution, masks timing bugs |
| AP-NG07 | Untyped Reactive Forms | No compile-time field checks, all values \`any\` |
| AP-NG08 | Component Without OnPush | Performance degradation, hides reactivity bugs |
| AP-NG09 | Class-Based Guards/Interceptors | Deprecated, unnecessary boilerplate |
| AP-NG10 | Cross-App Imports in Nx | Violates boundaries, circular deps, blocks independent deployment |
`;

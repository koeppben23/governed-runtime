/**
 * @module config/profiles/content/angular
 * @description Angular + Nx profile rule content for LLM guidance.
 *
 * This content is injected into FlowGuard tool responses when the Angular
 * profile is active. It supplements the universal FlowGuard mandates (flowguard-mandates.md) with
 * Angular-specific naming, architecture, testing, and anti-pattern rules.
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
# Angular + Nx Profile Rules

These rules supplement the universal FlowGuard mandates. They apply when the
FlowGuard system detects an Angular + Nx stack in the repository.

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

- Mark unverified runtime claims as \`NOT_VERIFIED\`.
- Mark beliefs not checked against artifacts as \`ASSUMPTION\`.
- Include recovery or verification steps when they are actionable.

---

## 2. Naming Conventions

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

## 3. Architecture and Boundaries

- Respect \`apps/*\` vs \`libs/*\` layering and tag constraints.
- Shared code belongs in \`libs/*\`; avoid app-to-app leakage.
- Use workspace aliases; avoid deep relative imports.
- New capability: implement as feature/data-access/ui libraries, not app-local sprawl.

---

## 4. Implementation Standards

### Components
- MUST keep focused: presentational vs container responsibilities.
- MUST NOT place heavy computation in templates.
- MUST use explicit inputs/outputs and typed view models.

### Change Detection & Reactivity
- MUST preserve repo default strategy. Use deterministic reactive composition.
- MUST NOT use nested subscriptions. Use \`async\` pipe, signals, or repo-standard teardown.

### Forms
- Use repo form pattern (typed reactive forms if present).
- Validation messages must be predictable and testable.

### API Boundaries
- MUST keep transport DTOs at boundaries. Map to view/domain models.
- MUST NOT leak raw backend payload shapes through UI layers.

### Security
- MUST NOT place secrets/PII in logs. MUST use safe HTML binding (XSS-aware). MUST preserve CSP.

---

## 5. Quality Gates (Hard Fail)

| Gate | Fail Condition |
|------|---------------|
| FQG-1 Build/Lint | affected build/lint fails |
| FQG-2 Boundary | Nx/project boundary violations |
| FQG-3 Test Quality | missing deterministic tests, flaky async, missing negative-path |
| FQG-4 Contract | contract/client drift, edited generated code |
| FQG-5 A11y/UX | obvious a11y regressions (roles/labels/focus/keyboard) |

Quality gates are unconditional. Repository conventions and local style may
narrow implementation choices only inside passing gates. They must never
override hard-fail gates, SSOT, schemas, fail-closed behavior, or universal
mandates.

---

## 6. Verification Commands

Use repo-native verification commands first:
1. Documented CI commands (from CI config, README, or CONTRIBUTING)
2. Project scripts (package.json scripts, nx affected, ng commands)
3. Framework defaults (\`ng build\`, \`ng test\`) only if repo-native absent

If no verification command is runnable, mark result as \`NOT_VERIFIED\`
and emit recovery steps.

---

## 7. Anti-Patterns (detect and avoid)

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
| AP-NG09 | Class-Based Guards/Interceptors | Prefer functional guards/interceptors in Angular 15.2+; keep class-based APIs when repo version or convention requires them |
| AP-NG10 | Cross-App Imports in Nx | Violates boundaries, circular deps, blocks independent deployment |`;

// ─── Phase-Specific Sections ─────────────────────────────────────────────────

const DECISION_TREES = `\
## Decision Trees

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
\`\`\``;

const TESTING_RULES = `\
## Testing Rules

### Unit/Component Tests
- Deterministic and behavior-focused.
- Test user-visible outcomes over implementation internals.
- No low-signal assertions (\`truthy\`/snapshot spam).

### Integration Tests
- Cover state transitions, async boundaries, form/validation behavior.
- Mock only external edges.

### E2E (if established)
- Critical user journeys. Stable selectors (\`data-testid\`). No fixed sleeps.`;

const FEW_SHOT_EXAMPLES = `\
## Few-Shot Examples (Anti-Pattern Corrections)

<examples>
<example id="AP-NG01" type="anti-pattern">
<incorrect>
// BUSINESS LOGIC IN COMPONENT — orchestration, HTTP, and domain rules mixed into UI
@Component({ selector: 'app-user-page', template: '...' })
export class UserPageComponent {
  users: User[] = [];
  constructor(private http: HttpClient) {}
  ngOnInit() {
    this.http.get<User[]>('/api/users').subscribe(data => {
      this.users = data.filter(u => u.role === 'admin' && u.active);
    });
  }
  deactivate(user: User) {
    if (user.role !== 'superadmin') {
      this.http.patch(\`/api/users/\${user.id}\`, { active: false }).subscribe();
    }
  }
}
</incorrect>
<correct>
// Container delegates to facade, presentational via input/output
@Component({
  selector: 'app-user-page',
  template: \`<app-user-list [users]="vm()" (deactivate)="onDeactivate($event)" />\`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UserPageComponent {
  private readonly facade = inject(UserFacade);
  readonly vm = this.facade.activeAdmins;
  onDeactivate(user: User) { this.facade.deactivate(user.id); }
}
</correct>
<why>Business logic in components is untestable without TestBed, not reusable, and tightly couples UI to API shape.</why>
</example>

<example id="AP-NG03" type="anti-pattern">
<incorrect>
// DIRECT HTTPCLIENT IN COMPONENT — scattered API knowledge
@Component({ selector: 'app-user-list', template: '...' })
export class UserListComponent implements OnInit {
  users: User[] = [];
  constructor(private http: HttpClient) {}
  ngOnInit() {
    this.http.get<User[]>('/api/v2/users?active=true').subscribe(data => {
      this.users = data;
    });
  }
  delete(id: number) {
    this.http.delete(\`/api/v2/users/\${id}\`).subscribe(() => {
      this.users = this.users.filter(u => u.id !== id);
    });
  }
}
</incorrect>
<correct>
// API boundary isolated in service — component delegates
@Component({
  selector: 'app-user-list',
  template: '...',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UserListComponent {
  private readonly facade = inject(UserFacade);
  readonly users = this.facade.activeUsers;
  onDelete(id: number) { this.facade.delete(id); }
}
</correct>
<why>HTTP calls in components scatter API knowledge across the UI layer, require HttpClientTestingModule for every component test, and break multiple components when API paths change.</why>
</example>

<example id="AP-NG04" type="anti-pattern">
<incorrect>
// LEAKED BACKEND DTO — backend response shape used directly in template
@Component({
  template: \`<span>{{ user._embedded.profile.display_name }}</span>
             <span>{{ user.metadata.created_at | date }}</span>\`,
})
export class UserCardComponent {
  @Input() user!: UserApiResponse; // raw backend shape
}
</incorrect>
<correct>
// View model decouples UI from backend structure
interface UserCardViewModel {
  readonly displayName: string;
  readonly createdAt: Date;
}
@Component({
  template: \`<span>{{ vm.displayName }}</span>
             <span>{{ vm.createdAt | date }}</span>\`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UserCardComponent {
  @Input({ required: true }) vm!: UserCardViewModel;
}
</correct>
<why>Using backend DTOs in templates couples the UI to the API schema. Any backend field rename, nesting change, or API version migration breaks multiple components simultaneously.</why>
</example>

<example id="AP-NG05" type="anti-pattern">
<incorrect>
// NESTED SUBSCRIPTIONS — memory leaks, race conditions
ngOnInit() {
  this.route.params.subscribe(params => {
    this.userService.getUser(params['id']).subscribe(user => {
      this.orderService.getOrders(user.id).subscribe(orders => {
        this.orders = orders;
      });
    });
  });
}
</incorrect>
<correct>
// Flat reactive chain with proper teardown
private readonly route = inject(ActivatedRoute);
readonly orders$ = this.route.params.pipe(
  switchMap(params => this.userService.getUser(params['id'])),
  switchMap(user => this.orderService.getOrders(user.id)),
);
</correct>
<why>Nested subscriptions leak memory, race on rapid navigation, produce unpredictable error states, and are untestable.</why>
</example>

<example id="AP-NG06" type="anti-pattern">
<incorrect>
// FIXED WAITS IN TESTS — flaky, slow, masks timing bugs
it('should load users after delay', fakeAsync(() => {
  component.ngOnInit();
  tick(2000); // magic number, why 2000?
  fixture.detectChanges();
  expect(component.users.length).toBeGreaterThan(0);
}));
</incorrect>
<correct>
// Deterministic trigger — no arbitrary delay
it('should display users after API response', () => {
  const mockUsers = [{ id: 1, name: 'Alice' }];
  httpMock.expectOne('/api/users').flush(mockUsers);
  fixture.detectChanges();
  const rows = fixture.nativeElement.querySelectorAll('[data-testid="user-row"]');
  expect(rows.length).toBe(1);
});
</correct>
<why>Fixed waits make tests flaky on slow CI, slow to execute, and mask real timing bugs. Deterministic triggers (flush, resolve, emit) produce reliable tests that fail for the right reasons.</why>
</example>

<example id="AP-NG07" type="anti-pattern">
<incorrect>
// UNTYPED REACTIVE FORM — all values are 'any', no compile-time checks
this.form = this.fb.group({
  name: [''],
  email: [''],
  age: [0],
});
const name = this.form.get('naem')?.value; // typo not caught at compile time
</incorrect>
<correct>
// Typed reactive form — compile-time field and type checking
this.form = this.fb.nonNullable.group({
  name: ['', Validators.required],
  email: ['', [Validators.required, Validators.email]],
  age: [0, [Validators.min(0), Validators.max(150)]],
});
const name: string = this.form.controls.name.value; // type-safe, typo = compile error
</correct>
<why>Untyped forms bypass the type checker entirely. Field name typos, wrong value types, and missing validations become runtime bugs instead of compile errors.</why>
</example>

<example id="AP-NG02" type="anti-pattern">
<incorrect>
// MIXED STATE ARCHITECTURES — NgRx store and local BehaviorSubject for same data
@Component({ /* ... */ })
export class DashboardComponent {
  private localUsers$ = new BehaviorSubject<User[]>([]);

  constructor(private store: Store) {}

  loadUsers() {
    this.store.dispatch(loadUsers());        // dispatches to NgRx
    this.api.getUsers().subscribe(users =>
      this.localUsers$.next(users)           // also caches in local subject
    );
  }
}
</incorrect>
<correct>
// Single state authority — NgRx store is the only source
@Component({ /* ... */ })
export class DashboardComponent {
  users$ = this.store.select(selectAllUsers);

  constructor(private store: Store) {}

  loadUsers() {
    this.store.dispatch(loadUsers());  // store is the single authority
  }
}
</correct>
<why>Mixing NgRx store with local BehaviorSubjects creates competing state authorities. Data drifts between the two, components show stale or contradictory values, and debugging requires tracing multiple update paths.</why>
</example>
</examples>`;

const NEGATIVE_TEST_MATRIX = `\
## Minimum Negative Tests per Change Type

For every change, the following negative-path tests MUST exist:

| Change Type | MUST Test (negative path) |
|---|---|
| Container Component | facade method called with wrong args, error state displayed, loading state handled |
| Presentational Component | missing/null inputs render gracefully, events emit correct payload, empty list displayed |
| Facade/Store | error response -> error state, stale data handling, concurrent request cancellation |
| Guard | unauthorized user -> redirect, expired token -> redirect, missing route param -> deny |
| Form Component | required field empty -> validation message, invalid email -> validation message, submit with invalid form -> blocked |`;

const REVIEW_CHECKLIST = `\
## Stack-Specific Review Checklist

When reviewing Angular changes, MUST verify:

| Check | What to look for |
|-------|-----------------|
| OnPush Missing | New components without \`ChangeDetectionStrategy.OnPush\` |
| Nested Subscriptions | \`.subscribe()\` inside another \`.subscribe()\` callback |
| Boundary Violations | Feature lib importing from another feature lib, UI lib importing data-access |
| Untyped Forms | \`FormGroup\` without typed controls, \`.get('field')\` instead of \`.controls.field\` |
| Missing Teardown | Manual \`.subscribe()\` without \`takeUntilDestroyed()\`, \`async\` pipe, or explicit unsubscribe |
| Leaked DTOs | Backend response interfaces used directly in component templates |
| Fixed Waits | \`setTimeout\`, \`tick(1000)\`, or \`cy.wait()\` in tests instead of deterministic triggers |
| A11y Regressions | Missing \`aria-label\`, broken keyboard navigation, missing focus management |`;

// ─── Detected Stack Instruction ──────────────────────────────────────────────

const DETECTED_STACK_INSTRUCTION = `\
## Detected Stack

Use flowguard_status.detectedStack when present. Prefer detected tools,
frameworks, runtimes, and versions over generic defaults. Do not make
version-specific claims without repository evidence; mark unsupported
claims as NOT_VERIFIED.`;

// ─── Exported PhaseInstructions ──────────────────────────────────────────────

/**
 * Angular profile rule content as PhaseInstructions.
 *
 * - `base`: Always-injected content (conventions, naming, architecture,
 *   implementation standards, quality gates, anti-pattern reference table).
 * - `byPhase`: Phase-specific additions:
 *   - PLAN: detected stack + decision trees + testing rules + negative tests
 *   - PLAN_REVIEW: review checklist
 *   - IMPLEMENTATION: detected stack + testing rules + examples + negative tests
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
      NEGATIVE_TEST_MATRIX,
    PLAN_REVIEW: REVIEW_CHECKLIST,
    IMPLEMENTATION:
      DETECTED_STACK_INSTRUCTION +
      '\n\n---\n\n' +
      TESTING_RULES +
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
    ARCHITECTURE: DECISION_TREES,
    ARCH_REVIEW: DECISION_TREES + '\n\n---\n\n' + REVIEW_CHECKLIST,
  },
};

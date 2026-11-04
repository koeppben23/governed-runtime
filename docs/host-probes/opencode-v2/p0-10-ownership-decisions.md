# P0-10: remaining ownership decisions

Date: 2026-11-04. Inspected HEAD: `7d9560e2638408afa40f02bfa3d9052ef250039f`,
plus the explicitly described local follow-up. PR #1190 remains Draft / NO-GO.
This is a bounded source audit, not installed ACTIVE/Desktop acceptance or R4
certification. The two accepted changes (`167d7c57`, `7d9560e2`) remain closed.

## Decision vocabulary and evidence boundary

Each row has exactly one disposition: **canonical and necessary**, **historically
isolated**, **replace with V2**, or **demonstrably dispensable**. A disposition
is not evidence that the required work has already been implemented. In
particular, "replace with V2" is an open deletion/porting obligation, not an
exception permitting an obsolete runtime in the final product.

The graph analysis uses the existing production scanner, source classifier,
AST import collector, TypeScript resolution and type-erased imports. A separate
scan includes test/test-support importers. Filesystem consumers are checked
separately. Static absence is not full function reachability proof.

**Correction to the first audit:** all four asynchronous rails are imported by
both `async-rails.test.ts` and their respective co-located suites. The earlier
inventory named only the common suite; it was incomplete as a test inventory.
All five suites and their assertions remain unchanged in this follow-up.

## Modules

All paths in this table are relative to `src/`.
Within owner/test columns, `tools/` and `review/` are shorthand for the
corresponding subtrees of `src/integration/`; unqualified integration suite
names are relative to `src/integration/`.

| Candidate                                                 | Disposition              | Callers, purpose and canonical owner                                                                                                                                                                                                                                                                                                                          | Follow-up outcome / removal condition                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `integration/review/evidence/review-provenance.ts`        | demonstrably dispensable | No production or test importers, and no other symbol consumers found. Its extractor validates old `obligation.metadata` branch/SHA/content fields. Current provenance is bound through `state/evidence-review-subject.ts`, `state/evidence-review.ts`, `state/review-continuation.ts` and `tools/review-tool/continuation-authority.ts`, not this extractor.  | Removed locally, with placement entry and a no-reintroduction guard. No test/assertion removed, no replacement validator or provenance fallback added.                                                                                                                                                             |
| `providers/registry-validation.ts`                        | canonical and necessary  | Only `providers/registry-validation.test.ts` calls it. It checks the source-owned built-in extension array, duplicate identities, parser/codec/report consistency, profile/signature ownership and unsafe probe declarations. `providers/registry.ts` derives the runtime registry from the fixed array; this validator was not a runtime registration guard. | Moved locally to `providers/registry-validation-test-helpers.ts`, classified by the existing test-helper suffix. All implementation statements and test bodies are unchanged; only the test import and helper header change. No new runtime registration feature, no removed validation.                           |
| `integration/review/obligations/obligation-settlement.ts` | replace with V2          | Only `obligation-settlement.test.ts` calls it. Live closure is in `review/dispatch/native-review-capture-failure.ts`, `durable-dispatch.ts` and `native-review-settlement.ts`, with immutable lineage and outcome-specific retry rules.                                                                                                                       | BLOCKED for deletion until its seven assertion cases are exercised against those live owners. Do not inject the old generic "no repair reissue" helper into the V2 retry path or move it under a test-only name to hide it.                                                                                        |
| `rails/plan.ts`                                           | replace with V2          | `rails/plan.test.ts` and `rails/async-rails.test.ts`. Bundles author plan generation with injected reviewer callbacks. The current runtime owner is `integration/tools/plan/plan.ts`, with canonical plan authority helpers and native review dispatch/capture.                                                                                               | Keep all assertions pending porting; remove the old executor implementation only after the mappings below execute on the live owner. Do not reactivate its callback review as a second runtime.                                                                                                                    |
| `rails/implement.ts`                                      | replace with V2          | `rails/implement.test.ts` and `rails/async-rails.test.ts`. Its zero-check branch still runs historical `reviewAndRevise`. Current implementation recording is `integration/tools/implementation/implement.ts`; validation/review activation uses `tools/auto-validation.ts` and `tools/implementation-review-activation.ts`.                                  | BLOCKED for deletion until implementation freshness, zero-check and budget assertions are rebound to current owners. Merely relocating the historical executor would not close this item.                                                                                                                          |
| `rails/validate.ts`                                       | replace with V2          | `rails/validate.test.ts` and `rails/async-rails.test.ts`. Current execution and persistence owner is `integration/tools/validation/run-check-tool.ts`, invoked by `tools/auto-validation.ts` for system work.                                                                                                                                                 | Port ordered checks, evidence slots, failures, technical errors and zero-check cases before removal; never substitute agent-reported results or copy baseline PASS into post-implementation evidence.                                                                                                              |
| `rails/continue.ts`                                       | replace with V2          | `rails/continue.test.ts` and `rails/async-rails.test.ts`. This old function executes work and mutates review state. Current `integration/tools/simple/continue-tool.ts` is read-only routing; work belongs to the originating tools, automatic validation and native review owners.                                                                           | There is no equivalent current mutating `/continue` owner. Separate routing assertions from execution/approval assertions before removing this implementation. Wiring it into the current tool would be a regression, not cleanup.                                                                                 |
| `cli/opencode-runtime-compat.ts`                          | replace with V2          | No current production TypeScript importer or active demo filesystem reader. Test importers are `cli/opencode-runtime-compat.test.ts` and the historical V1 config comparison in `documentation/__tests__/demo-host-config.test.ts`.                                                                                                                           | Active demos already use the V2 candidate. The old classifier is still production-class source; isolate the historical pin as test data and reconcile its classifier tests before removing this module. Do not retarget historical V1 experiments or claim the current file is already excluded from distribution. |
| `shared/product-inventory.ts`                             | canonical and necessary  | Deliberate documentation-generation authority used outside the shipped entrypoint graph.                                                                                                                                                                                                                                                                      | Retain. Lack of runtime reachability does not make a build/documentation authority redundant.                                                                                                                                                                                                                      |

### Assertion-preserving port obligations

The following are target-owner mappings, **not completed assertion equivalence**.
No old rail or settlement suite is deleted, skipped or rewritten in this change.

| Existing suites                                                     | Assertions that must survive                                                                                                                                           | Current owner / verification surface                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rails/plan.test.ts`, plan group in `async-rails.test.ts`           | Admissibility, missing ticket, empty plan, user content, history/lineage, revision, convergence and policy budget                                                      | `tools/plan/plan.ts`, `tools/plan/plan-submission-state.ts`, native dispatch/capture; `tools-execute-planning.test.ts`, `tools/plan/plan-auto-approval.test.ts`, `review/dispatch/durable-dispatch.test.ts`                                                                                    |
| `rails/implement.test.ts`, implement group in `async-rails.test.ts` | Ticket/plan/baseline preconditions; fresh post-implementation slot; independent review activation; zero-check behavior; policy budget                                  | `tools/implementation/implement.ts`, `tools/implementation-review-activation.ts`, native capture; `tools-execute-implement.test.ts`, `auto-validation.test.ts`, `tools/implement-review-validation-gate.test.ts`                                                                               |
| `rails/validate.test.ts`, validate group in `async-rails.test.ts`   | Check order, commands/evidence, scope-specific slots, failure routing, infrastructure/timeout preservation and zero-check behavior                                     | `tools/validation/run-check-tool.ts`, `run-check-result.ts`, `auto-validation.ts`; `tools-execute-run-check.test.ts`, `auto-validation.test.ts`, `auto-validation-retry-authority.test.ts`                                                                                                     |
| `rails/continue.test.ts`, continue group in `async-rails.test.ts`   | Read-only guidance, ambiguity, gates and terminal handling; separately, work execution, review budgets, invalid ADR rejection and no advancement on `unable_to_review` | `tools/simple/continue-tool.ts` for routing (`tools/continue-tool.test.ts`); originating plan/implementation/architecture tools and native review for work. Old bundled callback expectations are not evidence of live independent review.                                                     |
| `review/obligations/obligation-settlement.test.ts` (seven cases)    | Keep bindable pending work; block three rejected-attempt variants; preserve fulfilled state; zero status mutation on broken material; pending-work invariant           | `state/review-continuation.ts` for material/continuation; `review/dispatch/native-review-capture-failure.ts`, `durable-dispatch.ts`, `native-review-settlement.ts` for atomic closure. Existing durable-ledger/retry tests are relevant but not proof that these seven cases have been ported. |

The old `/continue` suite expects one call to execute validation or an ADR
review iteration and mutate evidence. The current `/continue` tool returns
guidance without doing either. That is a concrete semantic mismatch: merely
redirecting the old import cannot preserve its assertions. Map the execution
assertions to the actual work owner instead of giving the read-only tool old
executor capabilities. This port is BLOCKED, not complete. Validation outcomes
must use `state/evidence-validation.ts`: an `inconclusive` outcome alone is not
proof of a technical block; trustworthy artifact failures and inconclusive
assertion extraction have distinct disposition rules.

## Six explicitly callable command surfaces

`visibility: 'compatibility'` currently affects presentation filtering. It does
not select an SDK runtime or weaken validation. The real native executor routes
productive tools through the canonical tool index only after verified ACTIVE
scope and existing workflow authority (`plugin-native-tools.ts`). A prompt or
`/hydrate` cannot create activation authority. No command is removed, renamed or
promoted by this audit.

| Invocation / catalogue ID                                                         | Disposition             | Actual contract and decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/hydrate` / `workflow.hydrate`                                                   | canonical and necessary | Retain authorized workflow reload/refresh through `tools/hydrate/hydrate.ts`. V2 activation belongs solely to `plugin-start-command.ts` and policy-authorized Start RPC; direct native tool execution requires existing bound ACTIVE workflow state. Do not equate catalogue `/start`→HYDRATE metadata with the native activation callback.                                                                                                                                                                                                                                 |
| `/ticket` / `workflow.ticket`                                                     | canonical and necessary | Current interface onto the same canonical `flowguard_ticket` task capture as `/task`, not a second executor or old input adapter. `tools/simple/ticket-tool.ts` binds actual content or runtime-read repository content. Preserve that contract; no separate ticket runtime is justified.                                                                                                                                                                                                                                                                                   |
| `/continue` / `workflow.continue`                                                 | canonical and necessary | Retain explicit read-only deterministic routing through `tools/simple/continue-tool.ts`, including READY ambiguity, gate and terminal responses. It needs no independent state transition because it executes none. The catalogue's phrase "advances the workflow" and machine-command metadata do not describe the actual tool's mutation behavior; do not wire the obsolete asynchronous rail to make that prose true.                                                                                                                                                    |
| `/resolve-implementation-challenge` / `workflow.resolve-implementation-challenge` | canonical and necessary | `tools/challenge/challenge-resolution.ts` records append-only, current-digest advisory resolution evidence. It checks challenge lifecycle and passing implementation-scope attempts and never grants review acceptance. Independent verdict remains mandatory.                                                                                                                                                                                                                                                                                                              |
| `/validate` / `workflow.validate`                                                 | canonical and necessary | Explicit manual execution/retry through the same `flowguard_run_check` owner used by automatic validation. It is not a second verifier or agent self-report path. Automatic work does not remove the need for recovery after errors. The template is scoped to baseline VALIDATION; do not infer post-implementation or whole-review behavior from its name.                                                                                                                                                                                                                |
| `/check` / `alias.check`                                                          | replace with V2         | Preserve the native manual check/review operation in `plugin-check-command.ts`: it establishes a bounded command scope, invokes the canonical check prompt under the build agent, waits, and clears scope/restores the prior agent. The catalogue still projects it as a simple RUN_CHECK/VALIDATE alias; `product-command-routing.test.ts` checks that projection, not the native callback. Reconcile that metadata/test contract with the actual V2 operation before declaring this item closed. Do not delete the native command or weaken its scope/cleanup assertions. |

Relevant existing command evidence: `plugin-start-command.test.ts`,
`plugin-governance-lifecycle-command.test.ts`, `plugin-beforehooks.test.ts`,
`plugin-v2.test.ts`, `installed-commands.test.ts`, `product-command-routing.test.ts`,
`tools/continue-tool.test.ts`, `tools-execute-ticket.test.ts`,
`tools/ticket-content-adoption.test.ts`, `tools/challenge-resolution-outcome.test.ts`,
`tools-execute-run-check.test.ts`, `auto-validation.test.ts` and
`auto-validation-retry-authority.test.ts`. Metadata tests alone do not establish
host-command authority or installed acceptance.

## Follow-up graph and verification boundaries

Executed static graph on the local follow-up: **723 production files / 247
integration files**, 3,849 internal import sites, zero unresolved relative
imports; package runtime closure 689, plugin runtime closure 601, combined
type/runtime closure 716. Seven production-class files remain outside that
combined closure: the old host classifier, settlement helper, four asynchronous
rails and product inventory. The removed provenance validator and relocated
registry checker no longer contribute shipped modules. Identical file counts
to the PR base do not prove lower complexity; integration count/bytes and
remaining executable old paths still matter.

The source-body comparison for the provider relocation excludes imports and
headers only: every implementation statement and every test statement must
remain byte-identical. Existing classification/build guards must exclude
`registry-validation-test-helpers.ts` from `dist` and the packed product.
No mutation profile, coverage selection, 15-second coverage timeout, threshold
or test budget is changed.

**Hosted CI on `7d9560e2`: FAIL**, not queued: run `41865272715`, coverage job
`126697807936`, reports 12,924 passed / 1 failed / 11 skipped. The failure is
`src/cli/iso27001-java-demo.test.ts` → "allows only one of two concurrent
publications for the same session": observed exits `[0, 0]`, expected `[0, 1]`.
No cause or flake is established. This is a separate publication-exclusivity
blocker; this ownership follow-up does not modify the wrapper, assertion or
timeout and does not claim to repair it.

Local follow-up verification: the narrow provider/provenance boundary selection
passes 46 tests; `npm test` passes **12,935 tests / 2 skipped** across 705 files,
including the complete integration project. Architecture passes **549 tests**;
type checks, strict lint and unused-dependency checks pass. The provider helper
and test implementation statements compare identical to `7d9560e2`; all five
old rail suites and the settlement suite compare byte-identical. The local
non-coverage pass does not establish the Hosted-CI failure's cause, a flake or
a publication fix. Coverage and default mutation certification remain
NOT_VERIFIED (`npm run test:coverage`, `npm run mutation`).

Build/doc-drift, format, unused-export and PR-base documentation checks also
pass. The rebuilt `dist` and `npm pack --dry-run` file list contain neither the
old provider validator, its new test helper nor the removed provenance module;
the production registry remains present. This is distribution-content evidence,
not a packed-install or final-candidate acceptance run.

**P0-10 remains open.** The safe provenance removal and registry test-support
relocation do not close the old rail/settlement/classifier assertion ports or
the native `/check` metadata discrepancy. Final import/call-path proof and
whole-test/coverage/default-mutation certification must follow their resolution
on the actual final HEAD. R4 and installed ACTIVE/Desktop acceptance remain
independently open.

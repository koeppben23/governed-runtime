# P0-10: remaining ownership decisions

## Current status and evidence scope — 2026-11-04

Review baseline: **`f048acc0d2782f17424526f6bfbe20b94ca72bc5`** (PR #1190,
Draft / **NO-GO**). The local follow-up to that baseline explicitly labels the
inherited duplicate settlement assertion; it proves no separate governance
rejection class.

| Surface                                       | Current disposition / evidence scope                                                                                                                            |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host classifier                               | Removed in `3c210bae`; nine purposes mapped to exact current-candidate selection, not installed-product certification.                                          |
| Generic settlement                            | Removed in `6dd00388`; seven purposes run on both artifact routes (14 component cases with real persistence).                                                   |
| Lifecycle artwork                             | V2-corrected SVG in `f048acc0`; diagram/transition checks are documentation evidence, not product acceptance.                                                   |
| Four historical rails                         | Still OPEN pending case-by-case current-owner evidence; no callback executor will be reactivated.                                                               |
| Latest full local tests / coverage            | Settlement working tree incorporated in `6dd00388`: 12,974 passed / 2 skipped; coverage 12,965 passed / 11 skipped. These results do not certify later commits. |
| ISO publication exclusivity                   | OPEN: earlier Hosted-CI `[0, 0]` observations remain unexplained; later passes establish neither a fix nor a flake.                                             |
| Default mutation / final installed acceptance | NOT_VERIFIED: `npm run mutation` and final SHA/artifact-bound CLI/Desktop workflow remain required.                                                             |
| R4                                            | Separate external host-security dependency; BLOCKED / NOT_SUPPORTED under the unchanged untrusted-plugin threat model.                                          |

The historical checkpoints below retain their original identities and scopes.
This status is not a P0-10 completion claim or final call-path certification.

## Historical audit and follow-ups

Original audit date: 2026-11-04. Inspected HEAD: `7d9560e2638408afa40f02bfa3d9052ef250039f`,
plus the explicitly described local follow-up. PR #1190 remains Draft / NO-GO.
This is a bounded source audit, not installed ACTIVE/Desktop acceptance or R4
certification. The two accepted changes (`167d7c57`, `7d9560e2`) remain closed.

**Metadata follow-up after `fd8d275f`:** F1/F2 are corrected in the catalogue,
help and structural projections: `/continue` has no mutating machine target;
`/check` has the explicit native target `check` and current identity
`operational.check`, not the removed `alias.check`/VALIDATE mapping. The
callback still owns ACTIVE-root admission, scope, agent execution and cleanup;
its execution body and the read-only continue tool are unchanged. These
corrections do not port the old asynchronous rails or settle R4.

The corrected help preflight is a display projection, not a new permission gate:
`/continue` is shown as read-only at work/gate/terminal phases and retains the
READY ambiguity blocker; `/check` is shown as eligible to attempt with a session,
not authorized by VALIDATE. Missing sessions still block both. Runtime tool
classification, audit reconciliation, capacity/scope guards, machine commands
and native admission are unchanged. The native registration now reads its copy
and native target from the catalogue and fails explicitly on missing/non-native
metadata; it does not dispatch a tool alias. ProofGraph validates and digest-binds
the native identity instead of serializing an invented run-check target.

An execution-body comparison to `fd8d275f` confirms that `executeCheckCommand`
and the entire current `tools/simple/continue-tool.ts` remain identical. The
ISO wrapper/test and all old rail/settlement suites also remain unchanged.

Executed on the F1/F2 metadata working tree after `fd8d275f`: 150 targeted
integration tests, 820 documentation tests / 1 skipped, and `npm test` with
**12,966 passed / 2 skipped**. The unchanged canonical `npm run test:coverage`
passes **12,957 tests / 11 skipped**, with statements **91.01%**, branches
**84.26%**, functions **95.48%** and lines **92.51%**. The ISO concurrent
publication assertion passes in this local coverage run too; that observation
still does not explain or repair its earlier failure. Default mutation
certification remains NOT_VERIFIED (`npm run mutation`), and these local
results are not Hosted-CI or installed ACTIVE/Desktop acceptance.

**New Hosted-CI counterexample on `27e9584b`:** run `41898050988`, coverage
job `126812753688`, again fails the same ISO publication assertion with
`[0, 0]` instead of `[0, 1]` (12,956 passed / 1 failed / 11 skipped).
An isolated unchanged local invocation of that exact test passes once; that
does not establish a flake or explain either failure. The subsequent diagnostic
change only attaches both publishers' captured stdout/stderr, exits and the
requested output root to the existing assertion. No publication code,
expected exit, timeout, test selection or retry behavior is changed.

**Hosted CI on diagnostic commit `41ad3301`: PASS**, run `41900744806`,
**37/37 jobs**, including coverage job `126822166867`. This later green run
does not explain either earlier `[0, 0]` publication result or establish a
flake/fix. It is not evidence for the subsequent classifier-port candidate.

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

| Candidate                                                 | Disposition              | Callers, purpose and canonical owner                                                                                                                                                                                                                                                                                                                          | Follow-up outcome / removal condition                                                                                                                                                                                                                                                    |
| --------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integration/review/evidence/review-provenance.ts`        | demonstrably dispensable | No production or test importers, and no other symbol consumers found. Its extractor validates old `obligation.metadata` branch/SHA/content fields. Current provenance is bound through `state/evidence-review-subject.ts`, `state/evidence-review.ts`, `state/review-continuation.ts` and `tools/review-tool/continuation-authority.ts`, not this extractor.  | Removed locally, with placement entry and a no-reintroduction guard. No test/assertion removed, no replacement validator or provenance fallback added.                                                                                                                                   |
| `providers/registry-validation.ts`                        | canonical and necessary  | Only `providers/registry-validation.test.ts` calls it. It checks the source-owned built-in extension array, duplicate identities, parser/codec/report consistency, profile/signature ownership and unsafe probe declarations. `providers/registry.ts` derives the runtime registry from the fixed array; this validator was not a runtime registration guard. | Moved locally to `providers/registry-validation-test-helpers.ts`, classified by the existing test-helper suffix. All implementation statements and test bodies are unchanged; only the test import and helper header change. No new runtime registration feature, no removed validation. |
| `integration/review/obligations/obligation-settlement.ts` | demonstrably dispensable | Only its old suite called it. The seven assertion purposes now run on `tools/plan/plan-route.ts` and `tools/architecture/architecture-restart.ts`, consuming canonical `state/review-continuation.ts` and `review/obligations/obligation-state.ts`.                                                                                                           | Removed after the 14-case plan/ADR port below. No runtime closure, retry authority, evidence writer or frozen-material verifier is replaced; no old executor moved into test support.                                                                                                    |
| `rails/plan.ts`                                           | replace with V2          | `rails/plan.test.ts` and `rails/async-rails.test.ts`. Bundles author plan generation with injected reviewer callbacks. The current runtime owner is `integration/tools/plan/plan.ts`, with canonical plan authority helpers and native review dispatch/capture.                                                                                               | Keep all assertions pending porting; remove the old executor implementation only after the mappings below execute on the live owner. Do not reactivate its callback review as a second runtime.                                                                                          |
| `rails/implement.ts`                                      | replace with V2          | `rails/implement.test.ts` and `rails/async-rails.test.ts`. Its zero-check branch still runs historical `reviewAndRevise`. Current implementation recording is `integration/tools/implementation/implement.ts`; validation/review activation uses `tools/auto-validation.ts` and `tools/implementation-review-activation.ts`.                                  | BLOCKED for deletion until implementation freshness, zero-check and budget assertions are rebound to current owners. Merely relocating the historical executor would not close this item.                                                                                                |
| `rails/validate.ts`                                       | replace with V2          | `rails/validate.test.ts` and `rails/async-rails.test.ts`. Current execution and persistence owner is `integration/tools/validation/run-check-tool.ts`, invoked by `tools/auto-validation.ts` for system work.                                                                                                                                                 | Port ordered checks, evidence slots, failures, technical errors and zero-check cases before removal; never substitute agent-reported results or copy baseline PASS into post-implementation evidence.                                                                                    |
| `rails/continue.ts`                                       | replace with V2          | `rails/continue.test.ts` and `rails/async-rails.test.ts`. This old function executes work and mutates review state. Current `integration/tools/simple/continue-tool.ts` is read-only routing; work belongs to the originating tools, automatic validation and native review owners.                                                                           | There is no equivalent current mutating `/continue` owner. Separate routing assertions from execution/approval assertions before removing this implementation. Wiring it into the current tool would be a regression, not cleanup.                                                       |
| `cli/opencode-runtime-compat.ts`                          | demonstrably dispensable | No production importer or active demo filesystem reader. Its nine safety cases now exercise the existing native acceptance resolver in `cli/opencode-candidate-contract.test.ts`. The historical config comparison reads the original V1 JSON snapshot directly.                                                                                              | Removed after the nine-case port below; no executable classifier moved to test support, no compatibility facade or replacement runtime introduced.                                                                                                                                       |
| `shared/product-inventory.ts`                             | canonical and necessary  | Deliberate documentation-generation authority used outside the shipped entrypoint graph.                                                                                                                                                                                                                                                                      | Retain. Lack of runtime reachability does not make a build/documentation authority redundant.                                                                                                                                                                                            |

### Completed host-classifier port: nine cases

The new `src/cli/opencode-candidate-contract.test.ts` transfers all nine test
cases to the existing `resolvePinnedOpenCodeHost` acceptance owner in
`src/cli/opencode-live-host-test-helpers.ts`. It adds no production behavior.
The old classifier's `verified`/`compatible-unverified`/deny-list DTO contract
is not retained: the current boundary accepts only the exact candidate and
rejects every nonmatch. Rejection is stronger than the old warning-only result;
candidate selection is explicitly **not** installed-product certification.

| Original case                        | Current executable assertion                                                                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Empty deny-list registry             | The obsolete classifier file is absent; the current authority is an `@opencode/cli` **candidate**, not a verified-host registry. No deny-list/range adapter remains. |
| Exact host is accepted               | Exact `opencode v<current candidate>` resolves to the explicit binary, without changing candidate status.                                                            |
| Newer patch                          | Explicit host probe fails with `OPENCODE_HOST_VERSION_MISMATCH`.                                                                                                     |
| Older host                           | The former older-version fixture cannot inherit candidate acceptance.                                                                                                |
| Newer minor                          | Explicit host probe fails, rather than warning and continuing.                                                                                                       |
| Synthetic known-incompatible version | The same `1.20.3` version is refused without rebuilding the old deny-list API.                                                                                       |
| Unknown/malformed host               | Both null output and malformed output fail closed.                                                                                                                   |
| Pin/baseline consistency             | Current candidate matches both native API package pins; the separate historical snapshot is still `opencode-ai` **1.19.5**, never silently promoted.                 |
| Prerelease/nightly                   | A nightly suffix cannot inherit exact-candidate acceptance.                                                                                                          |

`src/documentation/__tests__/demo-host-config.test.ts` retains its historical
host comparison and unchanged assertions. Only its pin source changes from the
deleted executable module to `.sdk-baselines/opencode/host-version.json`.
That JSON file is byte-unchanged. The updater's no-write regression continues
to protect that historical baseline and now also protects the current candidate
and historical test consumer. The architecture guard forbids reintroducing the
removed module and continues to reject host-range projections.

Executed static graph on this local port after `41ad3301`: **722 production
files / 247 integration files**, 3,853 internal import sites, zero unresolved
relative imports; package runtime closure 689, plugin runtime closure 601,
combined type/runtime closure 716. Six files remain outside that closure:
the four asynchronous rails, old settlement helper and deliberate product
inventory authority. This is a progress snapshot, not final P0-10 call-path
certification or a net-complexity claim.

Local classifier-port verification: **64 targeted tests passed / 1 historical
host test skipped**, 15 updater tests passed, **549 architecture tests passed**;
`npm test` passed **12,966 tests / 2 skipped** across 705 files. Type checks,
strict lint, format, build/doc-drift, unused dependencies and the unchanged
unused-export gate passed. The rebuilt distribution and 2,893-file
`npm pack --dry-run` inventory contain neither the removed classifier nor the
new test suite. Working-tree changelog validation against the PR base passed;
the committed PR-base gate is run separately after committing. This is not
installed acceptance. **NOT_VERIFIED:** coverage and default mutation for this
port (`npm run test:coverage:ci`, `npm run mutation`); final certification remains
required on the eventual candidate.

### Completed settlement port: seven purposes on both current artifact routes

`src/integration/tools/plan/plan-route.test.ts` co-locates with the live plan
continuation owner and also executes the corresponding ADR route. Each of the
seven purposes runs against both owners (**14 cases**) with canonical session
binding, real artifact materialization, schema-validated persistence and the
current continuation authority. The old suite and unused 65-line executor are
removed only after those current-owner tests execute successfully.

| Original case / purpose                            | Current executable assertions (plan and ADR)                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep bindable pending work                         | Exact obligation/attempt re-emitted with required dispatch; persisted state byte-unchanged.                                                                                                                                                                                                                                                                                                                                        |
| Block output rejection                             | Exact `REVIEW_ATTEMPT_UNAVAILABLE` response and persisted blocked obligation; no reissue, evidence, dispatch or phase change.                                                                                                                                                                                                                                                                                                      |
| Inherited duplicate structured rejection           | The original suite used the same `consistency_invalid` fixture for two labels. The duplicate remains explicitly labelled as such, not as a separate governance or security rejection class.                                                                                                                                                                                                                                        |
| Block reasonless rejection                         | Same durable closure without relying on a structured rejection marker.                                                                                                                                                                                                                                                                                                                                                             |
| Preserve fulfilled state                           | Routing returns no new instruction and leaves evidence/attempt/dispatch and state bytes unchanged; canonical continuation is `awaiting_verdict`. The fixture now has mandatory current invocation and completed-release lineage, not the old invalid bare `fulfilled` record. Routing is not evidence certification or verdict approval.                                                                                           |
| Broken frozen material: zero status mutation       | The old subject-digest mismatch is explicitly rejected at the current persistence schema with unchanged disk bytes. A schema-valid content/digest mismatch also executes both routes: `REVIEW_MATERIAL_INTEGRITY_FAILED`, obligation still pending, no blocked code, byte-unchanged persisted state.                                                                                                                               |
| Every intact pending item has a legal continuation | Rejected-only work becomes blocked; bindable-only work stays pending with its exact attempt. The old mixed fixture contained **two initial attempts** and is explicitly refused by the schema, never normalized. The legal V2 rejected-plus-created shape is built through the existing bounded re-arm owner with completed-release provenance, then both artifact routes preserve the exact fresh attempt and all prior evidence. |

The last fixture tests continuation after an authorized re-arm, not independent
F12 adjudication or host integrity. Existing `incoherent-capture-rearm.test.ts`
and execution/recovery suites remain unchanged and still own retry authorization
and negative cases. A rejected attempt alone never gains retry authority.
Native capture/terminal settlement and their stricter dispatch/child lineage
remain untouched; the initial proposed mapping to those owners was insufficient
for these seven generic continuation purposes. The current artifact routes are
the actual owners of missing-attempt closure.

The placement manifest drops the deleted file and its now-unnecessary
obligations-zone exception; the target remains **12**, not a weakened budget.
An executable architecture guard rejects reintroduction of the retired file or
its function in production source. Four rail implementations and all five old
rail suites are unchanged by this settlement port.

Executed source graph after `3c210bae`: **721 production / 246 integration
files**, 3,848 internal import sites, zero unresolved relative imports; shipped
runtime closures remain 689 package / 601 plugin, combined type/runtime 716.
Only the four rails and deliberate `shared/product-inventory.ts` build authority
remain outside that combined graph. This is static reachability evidence, not
complete call-path proof or net-complexity certification.

Local settlement-port verification: **113 targeted tests passed**, including
the 14 new plan/ADR cases and unchanged planning, dead-state recovery and F12
re-arm suites. `npm test` passed **12,974 tests / 2 skipped** across 705 files,
including the complete integration project. Architecture passed **550 tests**;
type checks, strict lint, format, build/doc-drift, unused dependencies and the
unchanged unused-export gate passed. The rebuilt distribution and 2,889-file
`npm pack --dry-run` inventory exclude both retired modules and the new suite.
The seven-to-seven purpose manifest records both route families and byte-identical
rail implementations/suites, live continuation/closure/retry owners and coverage
configuration. Working-tree changelog validation against the PR base passed;
the committed PR-base gate is run separately after committing.
The unchanged `npm run test:coverage:ci` gate also passed **12,965 tests /
11 skipped** across 705 files (354.82 seconds): statements **91.02%**, branches
**84.28%**, functions **95.50%**, lines **92.51%**. This covers the classifier and
settlement retirements together, not subsequent documentation/diagram work or
installed acceptance. It does not explain the earlier Hosted-CI ISO failures.
**NOT_VERIFIED:** default mutation (`npm run mutation`) and final installed
candidate acceptance; no specialized profile substitutes for that certification.

### Remaining assertion-preserving port obligations

The following are target-owner mappings, **not completed assertion equivalence**.
No old rail suite is deleted, skipped or rewritten in this change.

| Existing suites                                                     | Assertions that must survive                                                                                                                                           | Current owner / verification surface                                                                                                                                                                                                       |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rails/plan.test.ts`, plan group in `async-rails.test.ts`           | Admissibility, missing ticket, empty plan, user content, history/lineage, revision, convergence and policy budget                                                      | `tools/plan/plan.ts`, `tools/plan/plan-submission-state.ts`, native dispatch/capture; `tools-execute-planning.test.ts`, `tools/plan/plan-auto-approval.test.ts`, `review/dispatch/durable-dispatch.test.ts`                                |
| `rails/implement.test.ts`, implement group in `async-rails.test.ts` | Ticket/plan/baseline preconditions; fresh post-implementation slot; independent review activation; zero-check behavior; policy budget                                  | `tools/implementation/implement.ts`, `tools/implementation-review-activation.ts`, native capture; `tools-execute-implement.test.ts`, `auto-validation.test.ts`, `tools/implement-review-validation-gate.test.ts`                           |
| `rails/validate.test.ts`, validate group in `async-rails.test.ts`   | Check order, commands/evidence, scope-specific slots, failure routing, infrastructure/timeout preservation and zero-check behavior                                     | `tools/validation/run-check-tool.ts`, `run-check-result.ts`, `auto-validation.ts`; `tools-execute-run-check.test.ts`, `auto-validation.test.ts`, `auto-validation-retry-authority.test.ts`                                                 |
| `rails/continue.test.ts`, continue group in `async-rails.test.ts`   | Read-only guidance, ambiguity, gates and terminal handling; separately, work execution, review budgets, invalid ADR rejection and no advancement on `unable_to_review` | `tools/simple/continue-tool.ts` for routing (`tools/continue-tool.test.ts`); originating plan/implementation/architecture tools and native review for work. Old bundled callback expectations are not evidence of live independent review. |

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

| Invocation / catalogue ID                                                         | Disposition             | Actual contract and decision                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/hydrate` / `workflow.hydrate`                                                   | canonical and necessary | Retain authorized workflow reload/refresh through `tools/hydrate/hydrate.ts`. V2 activation belongs solely to `plugin-start-command.ts` and policy-authorized Start RPC; direct native tool execution requires existing bound ACTIVE workflow state. Do not equate catalogue `/start`→HYDRATE metadata with the native activation callback.                                 |
| `/ticket` / `workflow.ticket`                                                     | canonical and necessary | Current interface onto the same canonical `flowguard_ticket` task capture as `/task`, not a second executor or old input adapter. `tools/simple/ticket-tool.ts` binds actual content or runtime-read repository content. Preserve that contract; no separate ticket runtime is justified.                                                                                   |
| `/continue` / `workflow.continue`                                                 | canonical and necessary | Read-only routing through `tools/simple/continue-tool.ts`, including READY ambiguity, gates and terminal responses. The metadata now describes guidance and has no CONTINUE machine target; help reports read-only eligibility. No old executor is wired into the tool.                                                                                                     |
| `/resolve-implementation-challenge` / `workflow.resolve-implementation-challenge` | canonical and necessary | `tools/challenge/challenge-resolution.ts` records append-only, current-digest advisory resolution evidence. It checks challenge lifecycle and passing implementation-scope attempts and never grants review acceptance. Independent verdict remains mandatory.                                                                                                              |
| `/validate` / `workflow.validate`                                                 | canonical and necessary | Explicit manual execution/retry through the same `flowguard_run_check` owner used by automatic validation. It is not a second verifier or agent self-report path. Automatic work does not remove the need for recovery after errors. The template is scoped to baseline VALIDATION; do not infer post-implementation or whole-review behavior from its name.                |
| `/check` / `operational.check`                                                    | canonical and necessary | Native manual check/review operation in `plugin-check-command.ts`. The catalogue now identifies the native callback, not a RUN_CHECK/VALIDATE alias; registration copy, help, routing tests and ProofGraph agree. ACTIVE-root admission, bounded scope, build-agent execution, wait and cleanup remain in the callback. Tool phase/evidence/policy guards are not bypassed. |

Relevant existing command evidence: `plugin-start-command.test.ts`,
`plugin-governance-lifecycle-command.test.ts`, `plugin-beforehooks.test.ts`,
`plugin-v2.test.ts`, `installed-commands.test.ts`, `product-command-routing.test.ts`,
`tools/continue-tool.test.ts`, `tools-execute-ticket.test.ts`,
`tools/ticket-content-adoption.test.ts`, `tools/challenge-resolution-outcome.test.ts`,
`tools-execute-run-check.test.ts`, `auto-validation.test.ts` and
`auto-validation-retry-authority.test.ts`. Metadata tests alone do not establish
host-command authority or installed acceptance.

## Follow-up graph and verification boundaries

Executed static graph for the `fd8d275f` follow-up: **723 production files / 247
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

**Hosted CI on `fd8d275f`: PASS**, run `41890648033`, **37/37 jobs**.
Coverage job `126786822294` passes **12,926 tests / 11 skipped** across 705
files, including the ISO publication assertion. No publication-path change
separates these commits. This later green run does not establish the previous
failure's cause or certify it as a flake. The F1/F2 metadata patch is a separate
working tree and must not inherit this Hosted-CI result.

Local `fd8d275f` follow-up verification: the narrow provider/provenance boundary selection
passes 46 tests; `npm test` passes **12,935 tests / 2 skipped** across 705 files,
including the complete integration project. Architecture passes **549 tests**;
type checks, strict lint and unused-dependency checks pass. The provider helper
and test implementation statements compare identical to `7d9560e2`; all five
old rail suites and the settlement suite compare byte-identical. The local
non-coverage pass does not establish the Hosted-CI failure's cause, a flake or
a publication fix. At that initial local checkpoint coverage and default
mutation certification had not been run; subsequent Hosted-CI and F1/F2 local
coverage results are recorded separately above. Default mutation remains open.

Build/doc-drift, format, unused-export and PR-base documentation checks also
pass. The rebuilt `dist` and `npm pack --dry-run` file list contain neither the
old provider validator, its new test helper nor the removed provenance module;
the production registry remains present. This is distribution-content evidence,
not a packed-install or final-candidate acceptance run.

**P0-10 remains open.** The safe provenance removal and registry test-support
relocation and current F1/F2 metadata fixes do not close the old
rail assertion ports. The classifier and settlement ports above are complete.
Final import/call-path proof and
whole-test/coverage/default-mutation certification must follow their resolution
on the actual final HEAD. R4 and installed ACTIVE/Desktop acceptance remain
independently open.

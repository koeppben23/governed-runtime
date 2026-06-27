# Roadmap

## Product Direction

FlowGuard should make modern LLMs safely effective on unfamiliar repositories by
providing evidence-bound repository intelligence, repo-specific implementation
guidance, adversarial review, and policy-gated verification.

The goal is not to make LLMs more cautious by default. The goal is to make
stronger LLMs more useful by giving them high-quality repository context, clear
constraints, and falsification-first review.

## Principles

- Prefer repository-local evidence over generic best practices.
- Treat inferred repository intelligence as advisory unless policy explicitly
  gates on it.
- Do not turn conventions, business-rule hypotheses, or reviewer prompts into
  new governance authorities.
- Preserve canonical authorities for state, policy, evidence, audit, review, and
  validation.
- Mark uncertain, stale, degraded, or unproven claims as `NOT_VERIFIED`.
- Scale strictness by task risk and policy mode instead of applying maximum
  ceremony to every task.
- Keep product behavior deterministic, fail-closed, and audit-ready at trust
  boundaries.
- Make the smallest useful slice before adding broader automation.

## Non-Goals

- FlowGuard should not replace repository-local contracts, schemas, tests, CI, or
  ownership models.
- FlowGuard should not accept LLM-inferred business rules as facts without
  evidence and confidence classification.
- FlowGuard should not silently approve work because Discovery, review transport,
  or verification is unavailable.
- FlowGuard should not enforce high-risk ceremony on trivial changes unless
  policy or changed-surface analysis requires it.
- FlowGuard should not create parallel registries for concepts already owned by a
  canonical authority.

## Roadmap

### Phase 0: Repo Intelligence Foundation

Build the common contract that later capabilities use without becoming new
runtime authority.

- Define an evidence taxonomy for repository intelligence: `fact`,
  `derived_signal`, `hypothesis`, and `NOT_VERIFIED`.
- Define a compact Repo Intelligence projection for Plan, Implement, Review, and
  status surfaces.
- Keep large artifacts outside session state; embed only summaries, digests, and
  stable references where needed.
- Define policy-gated strictness levels for advisory, required, and fail-closed
  behavior.

### Phase 1: Convention Mining And Authority Mapping

Make unfamiliar repositories legible to LLMs before they plan or modify code.

- Mine repository conventions for error handling, naming, file layout, testing,
  mocking, logging, configuration, dependency injection, public API shape, and
  generated artifacts.
- Identify likely canonical authorities: schemas, config, state machines,
  contracts, validators, routers, migrations, generated sources, and package
  surfaces.
- Surface convention and authority evidence with examples and confidence.
- Feed relevant conventions and authorities into Plan, Implement, and Review.

### Phase 2: Implementation Guidance And Scope Control

Constrain implementation to repo-specific evidence and the approved plan.

- Provide Implementation Guidance 2.0 with relevant files, similar examples,
  affected tests, contracts, conventions, likely authorities, and risk hotspots.
- Map implementation changes back to approved plan steps.
- Detect scope creep: unrelated files, new dependencies, public API changes,
  generated-file edits, large refactors, config changes, or behavior changes not
  covered by the plan.
- Require explicit `NOT_VERIFIED` markers for planned checks or claims that were
  not executed or proven.

### Phase 3: Business Rule Extraction

Protect domain behavior, not just code shape.

- Extract candidate business rules from tests, validators, schemas, domain
  services, state machines, API contracts, database constraints, docs, and error
  messages.
- Classify each rule by evidence and confidence instead of treating inference as
  truth.
- Map changed files and task text to potentially affected rules.
- Map rules to existing tests where evidence exists.
- Require reviewers to check affected business rules and to mark unsupported
  claims as `NOT_VERIFIED`.

### Phase 4: Test Intelligence And TDD Evidence

Move from generic verification to task-specific proof.

- Mine test layout, test framework, naming conventions, fixture style, mocking
  patterns, and public-interface testing expectations.
- Derive narrowest sufficient verification commands from scripts, CI, wrappers,
  docs, and changed surfaces.
- Add advisory TDD evidence for ordinary work and strict TDD evidence for
  bugfixes, business-rule changes, security work, public API changes, migrations,
  state machines, and high-risk tasks.
- Track whether a reproducing test, negative-path test, or business-rule test was
  added or executed; mark missing proof as `NOT_VERIFIED`.
- Review test quality: observable behavior, meaningful assertions, negative
  paths, regression relevance, and over-coupling to internals.

### Phase 5: Adversarial Review

Make independent review explicitly falsification-first and repository-aware.

- Extend reviewer criteria with adversarial checks for gate bypass, stale
  evidence reuse, duplicate authority, fail-open fallback, diagnostic-vs-authority
  confusion, missing negative tests, business invariant drift, and scope creep.
- Add reviewer anti-hallucination checks: accepted reviews need read evidence,
  concrete locations, verification discussion, and Discovery degradation handling.
- Enable policy-gated multi-review for high-risk work, with specialized
  correctness, security, test, architecture, and adversarial perspectives.
- Keep ReviewFindings, obligation binding, attestation, and validation as the
  acceptance authority; reviewer prompt text remains non-authoritative.

### Phase 6: Trust, Security, Release, And Compliance Analysis

Raise assurance for critical repository surfaces.

- Detect trust boundaries: identity, authorization, persistence, filesystem,
  network, secrets, crypto, audit/logging, payments, external integrations,
  packaging, and release.
- Review concrete security source-to-sink paths for injection, SSRF, path
  traversal, XSS, unsafe deserialization, auth bypass, privilege escalation, and
  secret leakage.
- Analyze migration safety for data loss, rollback, idempotency, transaction
  safety, and mixed-version deployment.
- Analyze dependency and supply-chain risk from new dependencies, lockfile drift,
  install scripts, unpinned CI actions, vulnerable packages, and package exports.
- Analyze release/package surfaces for generated artifacts, docs/API drift,
  version drift, install verification, and distribution contracts.

### Phase 7: Continuous Repo Intelligence

Keep repository intelligence fresh as the target repository changes.

- Detect Discovery drift for stack, commands, tests, conventions, business rules,
  authorities, and risk surfaces.
- Mine historical hotspots from Git history: churn-heavy files, bugfix-heavy
  modules, frequently reverted areas, flaky tests, and high-risk maintainers or
  paths where available.
- Build a repository quality model covering test maturity, convention clarity,
  architecture clarity, trust-boundary maturity, docs-code alignment, review
  readiness, and verification readiness.
- Present an improved human decision card with risk class, touched authorities,
  affected rules, conventions, executed checks, missing checks, reviewer findings,
  `NOT_VERIFIED` items, and residual risk.

## Near-Term MVP

The first major quality jump should stay narrow and evidence-bound.

1. Convention Mining.
2. Authority Map.
3. Reviewer consumption of conventions and authorities.
4. Implementation Guidance 2.0.
5. Scope Creep Detector.
6. Basic Test Intelligence.
7. Advisory TDD evidence for bugfix and high-risk tasks.

This slice should prove that FlowGuard improves LLM work on unfamiliar
repositories without adding a parallel governance authority or excessive process
for low-risk changes.

## Open Questions

- What is the smallest stable schema for conventions, authorities, business
  rules, and test intelligence?
- Which Repo Intelligence fields should be persisted, and which should remain
  runtime-only projections?
- Which signals are advisory in all modes, and which may become policy-gated in
  team or regulated modes?
- How much AST-based analysis is worth the maintenance cost compared with bounded
  heuristic mining?
- How should FlowGuard represent inferred business rules without encouraging LLMs
  to treat hypotheses as facts?
- What is the minimum useful proof for TDD evidence when Git history or command
  sequencing cannot establish a true red-before-green trail?
- Which high-risk surfaces should trigger multi-review by default?

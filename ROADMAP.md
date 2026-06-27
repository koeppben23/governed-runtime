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
- Repo Intelligence is a projection over repository-local evidence, not an
  authority. It may reference canonical authorities but must not replace, fork,
  or override them.
- Treat inferred repository intelligence as advisory unless policy explicitly
  gates on it.
- Do not turn conventions, business-rule candidates, or reviewer prompts into new
  governance authorities.
- Preserve canonical authorities for state, policy, evidence, audit, review, and
  validation.
- Mark uncertain, stale, degraded, or unproven claims as `NOT_VERIFIED`.
- Scale strictness by task risk and policy mode instead of applying maximum
  ceremony to every task.
- Reduced ceremony is a product requirement, not a UX afterthought. FlowGuard
  must identify low-risk work as deliberately as it identifies high-risk work.
- Design schemas before broad extractors. Convention mining, domain-invariant
  signals, and test intelligence should share one stable evidence model rather
  than inventing feature-local result shapes.
- Keep product behavior deterministic, fail-closed, and audit-ready at trust
  boundaries.
- Make the smallest useful slice before adding broader automation.

## Non-Goals

- FlowGuard should not replace repository-local contracts, schemas, tests, CI, or
  ownership models.
- FlowGuard should not accept LLM-inferred business rules as facts without
  evidence and confidence classification.
- FlowGuard should not make unverifiable claims appear more certain through
  structured formatting.
- FlowGuard should not silently approve work because Discovery, review transport,
  or verification is unavailable.
- FlowGuard should not enforce high-risk ceremony on trivial changes unless
  policy or changed-surface analysis requires it.
- FlowGuard should not create parallel registries for concepts already owned by a
  canonical authority.

## Near-Term Product Slice

The first product slice should prove that FlowGuard improves LLM work on
unfamiliar repositories without adding a parallel governance authority or
excessive process for low-risk changes.

This is not a complete quality solution. Downstream guidance will be only as
complete as the mined conventions and authorities in this slice.

1. Define `RepoIntelligenceSnapshot` v1 with `evidenceRefs`, `confidence`,
   `freshness`, `signalClass`, and `verificationState`.
2. Define decision semantics for signal classes: `fact` may support policy-gated
   blocking where configured; `derived_signal` may require corroboration;
   `hypothesis` should create review prompts and `NOT_VERIFIED` items, not
   automatic blocking decisions.
3. Add initial risk classification, including reduced-ceremony criteria for
   low-risk docs/text-only, test-only, and other explicitly safe changes.
4. Ship convention mining for two or three high-value concerns, with bounded
   inputs, confidence scoring, evidence examples, and tests.
5. Build an authority map for likely canonical authorities, generated artifacts,
   schemas, contracts, state machines, validators, and public package/API
   surfaces.
6. Feed relevant convention and authority signals into reviewer prompts and
   implementation guidance; acceptance remains governed by existing review
   findings, obligations, attestations, and validation.

## Later Capabilities

These capabilities are intentionally listed as later slices. They may be built in
parallel where ownership and dependencies are clear, but they should not bypass
the shared Repo Intelligence schema and decision semantics.

### Implementation Guidance And Scope Control

- Provide Implementation Guidance 2.0 with relevant files, similar examples,
  affected tests, contracts, conventions, likely authorities, and risk hotspots.
- Map implementation changes back to approved plan steps.
- Detect scope creep: unrelated files, new dependencies, public API changes,
  generated-file edits, large refactors, config changes, or behavior changes not
  covered by the plan.
- Require explicit `NOT_VERIFIED` markers for planned checks or claims that were
  not executed or proven.

### Domain Invariant Signals

- Mine domain-invariant candidates from tests, validators, schemas, domain
  services, state machines, API contracts, database constraints, docs, and error
  messages.
- Classify each candidate by evidence and confidence instead of treating
  inference as truth.
- Keep hypotheses non-blocking by default. They should drive review questions,
  missing-verification entries, and human acknowledgement, while only
  evidence-backed facts should be eligible for policy-gated blocking.

### Test Intelligence And TDD Evidence

- Mine test layout, test framework, naming conventions, fixture style, mocking
  patterns, and public-interface testing expectations.
- Derive narrowest sufficient verification commands from scripts, CI, wrappers,
  docs, and changed surfaces.
- Add advisory TDD evidence for ordinary work and strict TDD evidence for
  bugfixes, domain-invariant changes, security work, public API changes,
  migrations, state machines, and high-risk tasks.
- Review test quality: observable behavior, meaningful assertions, negative
  paths, regression relevance, and over-coupling to internals.

### Adversarial Review

- Extend reviewer criteria with adversarial checks for gate bypass, stale
  evidence reuse, duplicate authority, fail-open fallback, diagnostic-vs-authority
  confusion, missing negative tests, domain invariant drift, and scope creep.
- Add structured review fields for adversarial checks where needed. Text-only
  criteria improve behavior but cannot guarantee coverage; required fields make
  missing falsification visible and reviewable.
- Add reviewer anti-hallucination checks: accepted reviews need read evidence,
  concrete locations, verification discussion, and Discovery degradation handling.
- Enable policy-gated multi-review for high-risk work, with specialized
  correctness, security, test, architecture, and adversarial perspectives.
- Keep ReviewFindings, obligation binding, attestation, and validation as the
  acceptance authority; reviewer prompt text remains non-authoritative.

### Trust, Security, Release, And Compliance Analysis

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

### Continuous Repo Intelligence

- Detect Discovery drift for stack, commands, tests, conventions, domain-invariant
  signals, authorities, and risk surfaces.
- Mine historical hotspots from Git history: churn-heavy files, bugfix-heavy
  modules, frequently reverted areas, flaky tests, and high-risk paths where
  repository metadata supports it.
- Build a repository quality model covering test maturity, convention clarity,
  architecture clarity, trust-boundary maturity, docs-code alignment, review
  readiness, and verification readiness.
- Present an improved human decision card with risk class, touched authorities,
  affected signals, conventions, executed checks, missing checks, reviewer
  findings, `NOT_VERIFIED` items, and residual risk.

## Expected Quality Outcome

The roadmap should move routine LLM-assisted work from generic best-practice
execution toward senior-reviewer leverage: the human reviewer spends less time on
convention violations, obvious scope creep, and missing verification, and more
time on product intent, domain decisions, and novel architecture.

FlowGuard should not claim perfect quality. Runtime-only bugs, external domain
knowledge that is absent from the repository, and genuinely novel architectural
choices remain residual human-review responsibilities.

## Open Questions

- Which `NOT_VERIFIED` states belong in schemas versus presentation text?
- Which Repo Intelligence fields should be persisted, and which should remain
  runtime-only projections?
- Which signals are advisory in all modes, and which may become policy-gated in
  team or regulated modes?
- What exact criteria classify low-risk work for reduced ceremony without opening
  bypass paths?
- What is the minimum useful proof for TDD evidence when Git history or command
  sequencing cannot establish a true red-before-green trail?

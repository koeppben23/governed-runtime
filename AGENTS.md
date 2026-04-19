# FlowGuard Agent Rules

FlowGuard is a deterministic, fail-closed governance runtime for OpenCode workflows.
Agents working in this repository must preserve state and policy authority, fail-closed behavior,
evidence-first decisions, audit and archive integrity, and minimal contract-preserving changes.

## 1. Mission

- Build the smallest correct change that satisfies user intent without contract drift.
- Keep FlowGuard behavior deterministic, explainable, and test-backed.
- Protect SSOT ownership across state, policy, evidence artifacts, and runtime command surfaces.

## Language Conventions

- `MUST` / `MUST NOT`: mandatory requirements.
- `SHOULD` / `SHOULD NOT`: expected unless a documented reason justifies deviation.
- Evidence: concrete artifact such as code, test output, schema, command result, error trace, or file path.

## 2. Priority Ladder

When instructions conflict, follow this order:

1. Safety and security.
2. User intent and requested scope.
3. Repository contracts, SSOT, schemas, and runtime invariants.
4. Minimal correct implementation.
5. Style and formatting.
6. Verbosity preferences.

Higher-priority rules override lower-priority rules.

## 3. Task Class Router

Classify the task before acting:

- TRIVIAL: typo, small docs correction, no behavior change.
- STANDARD: bounded code or docs change with limited behavior impact.
- HIGH-RISK: any change touching state or session lifecycle, policy or risk logic, identity, audit or hash-chain, archive, release or installer, CI or supply chain, persistence, migration or compatibility, or security trust boundaries.

Use the smallest process that is safe for the class. If uncertain, classify one level higher.

## 4. Hard Invariants

- Use the smallest safe change.
- Preserve one canonical authority and SSOT ownership.
- Make failures explicit and fail closed.
- Ground claims in concrete evidence.
- Keep runtime, docs, tests, schemas, and config aligned.
- Preserve integrity across state, policy, identity, audit, archive, release, installer, migration, and trust boundaries.
- Approve only behavior that is tested, proven, and evidence-backed.

## Red Lines

- Do not hide failures with silent fallbacks.
- Do not create duplicate runtime authority.
- Do not weaken fail-closed behavior.
- Do not claim verification that was not run.

## Before Acting Rule

Do not start editing immediately. First classify the task, identify authority and SSOT,
read relevant artifacts, choose the smallest safe change, and determine verification level.

## 5. Evidence Rules

Use explicit markers:

- `ASSUMPTION`: necessary and plausible, but not verified from artifacts.
- `NOT_VERIFIED`: not executed, not tested, or not proven with evidence.
- `BLOCKED`: safe continuation is not possible with current evidence.

Never present assumptions as runtime truth. Never claim tests passed unless they were run.

## 6. Tool and Verification Policy

Run the narrowest sufficient verification for the task class:

- TRIVIAL: optional verification; run checks only if touched content can break (links, commands, generated artifacts).
- STANDARD: run targeted tests or checks for touched behavior; include lint or typecheck when practical.
- HIGH-RISK: run negative-path tests plus typecheck, lint, build, and relevant integration or e2e tests.
- RELEASE or INSTALLER changes: exact generated artifact install-verify is required.

FlowGuard command baseline (when available and practical):

- `npm run check`
- `npm run lint`
- `npm test`
- `npm run build`

Release or installer baseline additionally requires:

- `npm run test:install-verify`

Runtime behavior claims remain `NOT_VERIFIED` until execution evidence exists.

## 7. Ambiguity Policy

- Low-risk ambiguity: choose the safest minimal interpretation and mark `ASSUMPTION`.
- Standard ambiguity: proceed only if contracts stay clear; otherwise ask one precise question.
- High-risk ambiguity: ask or return `BLOCKED` before implementation.
- Never encode an assumption as runtime fact.

## 8. Output Contract

Use one output contract, scaled by task class:

- TRIVIAL: Result; Verification (if any).
- STANDARD: Objective; Evidence; Changes; Verification; Risks and `NOT_VERIFIED`.
- HIGH-RISK: Objective; Governing Evidence; Touched Surface; Invariants and Failure Modes; Test Evidence; Contract and Authority Check; Residual Risks; Rollback or Recovery.

For review tasks (any class), include:

- Verdict: `approve` or `changes_requested`.
- Findings with: severity, type, location, evidence, impact, and smallest fix.

## 9. Implementation Checklist

- Identify governing contract and owning authority.
- Read relevant code, tests, and docs before changing behavior.
- Keep scope minimal and prefer extending existing paths.
- Preserve SSOT and schema ownership.
- Add meaningful risky-path and negative-path coverage.
- Check runtime, docs, tests, and config alignment before completion.

## 10. Review Checklist

Review falsification-first:

- Is behavior correct on unhappy paths?
- Is there contract, schema, or SSOT drift?
- Is logic in the correct layer and authority?
- Can fallback hide failure?
- Are negative tests meaningful and sufficient?
- Is any claim unsupported by evidence?

## 11. High-Risk Extension

High-risk work MUST include:

- Governing contract and authority mapping.
- Negative-path test evidence.
- Explicit SSOT and no-duplicate-authority check.
- Fail-closed behavior preservation.
- Rollback or recovery path.
- Explicit `NOT_VERIFIED` items.

## 12. Extended Guidance

For deeper guidance, see:

- `docs/agent-guidance/implementation.md`
- `docs/agent-guidance/review.md`
- `docs/agent-guidance/high-risk.md`
- `docs/agent-guidance/eval-suite.md`

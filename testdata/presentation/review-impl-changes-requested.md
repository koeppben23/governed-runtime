# FlowGuard Review Report

**Status:** Implementation review in progress
**Overall:** issues
**Input:** pr

## ProofGraph

Status: NOT_DECLARED
No proof obligations declared.
Critical coverage: 0/0 proven
Evidence freshness: Not verified
Approval evidence: Not recorded
Verification effect: None — approval is not verification

Evidence lineage: `flowguard_status({ proofGraph: true })`

## Findings

### Critical (1)
- **Correctness:** Missing null check `src/payments/validate.ts`

### Major (1)
- **Quality:** Missing test coverage `src/payments/routes.ts`

## Completeness

**Overall:** Incomplete
**Four-eyes principle:** Not satisfied / Not recorded
**Summary:** 4/6 complete, 2 missing

## Recommended follow-up

- Address critical and major findings before merging.
- Add missing verification where listed.
- Re-run `/review` after changes if needed.

→ `/export` — Export the review evidence.

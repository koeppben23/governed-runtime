# FlowGuard Review Report

**Status:** Implementation review in progress
**Overall:** issues
**Input:** pr

## Verification

No verification obligations declared.
Approval evidence: Not recorded

Diagnostic: `flowguard_status({ proofGraph: true })`

## Findings

### Issues (2)
- **Correctness:** Missing null check
  Affected: BASE · src/subject.ts:8 · Evidence: 1 cited
  - BASE · src/subject.ts:8
  - HEAD · test/evidence.test.ts:4
- **Quality:** Missing test coverage
  Affected: BASE · src/subject.ts:8 · Evidence: 1 cited
  - BASE · src/subject.ts:8
  - HEAD · test/evidence.test.ts:4

## Completeness

**Overall:** Incomplete
**Four-eyes principle:** Not satisfied / Not recorded
**Summary:** 4/6 complete, 2 missing

## Recommended follow-up

- Address critical and major findings before merging.
- Add missing verification where listed.
- Re-run `/review` after changes if needed.

→ `/export` — Export the review evidence.

# FlowGuard Review Report

**Status:** Implementation review in progress
**Overall:** issues
**Input:** pr

## Verification

No verification obligations declared.
Approval evidence: Not recorded

Diagnostic: `flowguard_status({ proofGraph: true })`

## Findings

### Critical (1)
- **Correctness:** Missing null check `{"evidenceLocations":["validate"],"subjectAnchors":["payments"]}`

### Major (1)
- **Quality:** Missing test coverage `{"evidenceLocations":["routes"],"subjectAnchors":["payments"]}`

## Completeness

**Overall:** Incomplete
**Four-eyes principle:** Not satisfied / Not recorded
**Summary:** 4/6 complete, 2 missing

## Recommended follow-up

- Address critical and major findings before merging.
- Add missing verification where listed.
- Re-run `/review` after changes if needed.

→ `/export` — Export the review evidence.

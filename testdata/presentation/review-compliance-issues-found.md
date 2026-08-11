# FlowGuard Review Report

**Status:** Review complete
**Overall:** issues

## Verification

No verification obligations declared.
Approval evidence: Not recorded

Diagnostic: `flowguard_status({ proofGraph: true })`

## Findings

### Issues (2)
- **Completeness:** Missing evidence
  Affected: BASE · src/subject.ts:8 · Evidence: 1 cited
  - BASE · src/subject.ts:8
  - HEAD · test/evidence.test.ts:4
- **Risk:** Untracked dependency
  Affected: BASE · src/subject.ts:8 · Evidence: 1 cited
  - BASE · src/subject.ts:8
  - HEAD · test/evidence.test.ts:4

### Warnings (1)
- **Quality:** Missing changelog entry
  Affected: BASE · src/subject.ts:8 · Evidence: 1 cited
  - BASE · src/subject.ts:8
  - HEAD · test/evidence.test.ts:4

## Completeness

**Overall:** Incomplete
**Four-eyes principle:** Not satisfied / Not recorded
**Summary:** 1/3 complete, 2 missing

## Evidence

**Obligation:** `oblig-002`
**Invocation source:** agent-submitted-attested

## Recommended follow-up

- Address critical and major findings before merging.
- Add missing verification where listed.
- Re-run `/review` after changes if needed.

→ `/export` — Export the review evidence.

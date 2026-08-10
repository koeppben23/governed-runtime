# FlowGuard Review Report

**Status:** Review complete
**Overall:** issues
**Input:** branch

## Verification

No verification obligations declared.
Approval evidence: Not recorded

Diagnostic: `flowguard_status({ proofGraph: true })`

## Findings

### Critical (1)
- **Completeness:** Missing evidence `{"evidenceLocations":["evidence"],"subjectAnchors":["subject"]}`

### Major (1)
- **Risk:** Untracked dependency `{"evidenceLocations":["package"],"subjectAnchors":["dependency"]}`

### Warnings (1)
- **Quality:** Missing changelog entry `{"evidenceLocations":["evidence"],"subjectAnchors":["subject"]}`

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

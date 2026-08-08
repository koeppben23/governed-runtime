# FlowGuard Review Report

**Status:** Review complete
**Overall:** issues
**Input:** branch

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
- **Completeness:** Missing evidence

### Major (1)
- **Risk:** Untracked dependency `package.json`

### Warnings (1)
- **Quality:** Missing changelog entry

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

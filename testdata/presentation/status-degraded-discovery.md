## Status

**Phase:** Validation
**Readiness:** Not verified
**Policy:** solo

## Evidence

**Verified:** 1
**Missing:** 3
**Not yet required:** 5

## Available actions

- `/hydrate` — Prepare or restore a governed session.
- `/continue` — Route to the next workflow step.
- `/validate` — Record required verification results.
- `/abort` — End the current workflow without presenting it as completed.

## Discovery

⚠ Discovery data is degraded or unavailable. Runtime workflow authority is unchanged.
**Reason:** missing
**Recovery:** Run /hydrate to refresh discovery data.
**Not verified:** Repository drift, Code-surface completeness, Discovery drift, Code-surface completeness

→ `/check` — Run required verification checks.
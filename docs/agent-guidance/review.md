# Review Guidance

Use this guide for deeper review behavior while keeping root mandates authoritative.

## Review Posture

- Review falsification-first.
- Assume incorrectness until evidence proves correctness.
- Prefer concise, high-signal findings over broad narrative.

## What to Check

- Boundary correctness on unhappy paths.
- Contract consistency across code, tests, schemas, and docs.
- SSOT integrity and authority placement.
- Fail-closed behavior preservation.
- Negative-path coverage and test quality.
- Runtime/docs/test alignment.
- Hidden fallback, alias, or compatibility regressions.

## Finding Quality Bar

For each material finding, provide:

- location,
- evidence,
- impact,
- smallest credible fix.

Tag uncertainty explicitly with `ASSUMPTION`, `NOT_VERIFIED`, or `BLOCKED`.

## Review Output Shape

- Mergeability or verdict: `approve` or `changes_requested`.
- Must-fix items.
- Should-fix items.
- Nice-to-have items.
- Verification evidence run.
- Residual risk and `NOT_VERIFIED` items.

Do not define a second output contract; this section is guidance for applying the root contract.

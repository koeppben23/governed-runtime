# Schema Migration Architecture

**Status:** Superseded

FlowGuard uses hard version boundaries for persisted artifacts. Current session
state and audit formats are accepted only when they match their canonical
schemas. Older or malformed shapes reject at the relevant trust boundary.

Current rules:

- No read-time migration or defaulting of persisted FlowGuard shapes.
- No historical readers unless a domain explicitly defines one as current
  product behavior.
- No re-sealing, reinterpretation, or normalization of rejected artifacts.
- A contract replacement changes the canonical schema and rejects the former
  shape explicitly.

The former proposal for version registries, chained migrations, and
version-aware historical audit readers is retained only in repository history.
It is not a current implementation plan or product contract.

Current authorities:

- `src/state/schema.ts` for session state.
- `src/state/evidence-policy.ts` for frozen policy snapshots.
- `src/audit/integrity.ts` and `src/adapters/persistence-audit.ts` for audit
  envelope verification.

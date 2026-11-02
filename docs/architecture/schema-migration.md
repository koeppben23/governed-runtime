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

Explicitly defined current product behavior (operator decision 2026-11-02, #1190):

- **User configuration (`flowguard.json`).** Configuration is user-owned input,
  not a FlowGuard evidence artifact. A retired key whose value equals the
  default an earlier installer wrote has unchanged meaning and is dropped at
  read time; any other value of a retired key fails with a concrete reason.
  Owner: `src/config/flowguard-config.ts`. This does not apply to session
  state, evidence or audit.

Current authorities:

- `src/state/schema.ts` for session state.
- `src/state/evidence-policy.ts` for frozen policy snapshots.
- `src/audit/integrity.ts` and `src/adapters/persistence-audit.ts` for audit
  envelope verification.

# Context-Aware Mandates

FlowGuard renders governance mandates from one authority: `src/templates/mandates.ts`.
Phase-aware output, command governance rules, compaction summaries, and
`flowguard_status` governance projections are derived from that source plus canonical
session state. Tool footers are diagnostic wrappers, not mandate projections.

## Safety Boundary

Full mandates render fallback is a prompt-safety fallback only.
It does not authorize mutating runtime behavior.

When a phase is unknown, missing, invalid, or cannot be determined, prompt rendering may
return the full mandates so the model does not lose governance instructions. Mutating
runtime paths must still validate canonical state, policy, phase, and evidence before
changing anything. If that context is missing or invalid, the mutating path must block.

## Recovery Projections

Compaction context and `flowguard_status` are recovery and presentation helpers. They do
not own governance rules and must not contain independent rule-selection logic. They
project phase-relevant mandates from `src/templates/mandates.ts` and canonical state only.

Tool footers are diagnostic wrappers added by `src/integration/tools/index.ts`. They may
carry stop-condition and compaction-recovery reminders, but they are not mandate
projections and must not become a governance authority or next-action source.

## Host Harmonization

Host-covered rules may only shorten non-authoritative wording. Safety-critical sections
must never be fully removed:

- Red Lines
- Tool Error Classification
- Evidence Rules
- fail-closed and SSOT invariants

## Command Templates

Command templates must stay command-specific. Shared governance text comes from the
`Governance rules` mandates section via the compatibility `GOVERNANCE_RULES` projection;
templates must not copy semantic governance rules directly.

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

## Mandates Verbosity

FlowGuard may render the same mandates at different prompt-representation depths:

- `explicit`: default productive rendering and the safe path for installed mandates.
- `concise`: explicit operator opt-in only; reduces examples and repetition while keeping
  all normative anchors.
- `diagnosticSummary`: recovery/status/compaction summaries only; never installed as
  productive mandates.

Mandates verbosity is prompt representation only. It is not runtime allow, not model
trust, not compliance evidence, and not a governance tier. Unknown, missing, or invalid
verbosity resolves to `explicit`.

`modelId` may be recorded as metadata or evidence, but it must never select mandate
verbosity. FlowGuard must not ship a hardcoded frontier-model registry, a productive
compact tier, or automatic promotion from compliance-runner output.

Safety anchors outrank token targets. Concise rendering may remove examples and repeated
wording, but it must preserve Red Lines, Tool Error Stop, SSOT/single authority,
fail-closed/no-silent-fallback semantics, Evidence Markers, Phase Gates, Review
Obligations, Output Contracts, and Verification Policy.

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

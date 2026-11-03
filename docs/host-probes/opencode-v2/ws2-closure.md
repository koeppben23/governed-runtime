# WS2 closure and V2 reviewer-parity backlog

2026-11-02, PR #1190. **WS2 implementation checkpoint, not whole-PR acceptance.**
Finding 5, Finding 6, R4 and installed ACTIVE acceptance remain separate.

## WS2 closure

The eight WS2 packages are implemented:

1. historical V5 evidence remains readable and is never rewritten;
2. host-neutral session/message/call identities live in
   `src/state/host-identity.ts`;
3. the V5/V6 transport vocabulary is unchanged and no speculative V7 was added;
4. the HAI exposes only invoked ports;
5. review orchestration no longer branches on a host name or host environment;
6. `presentation.glyphProfile` is the neutral key, with the earlier
   `presentation.opencode.glyphProfile` accepted only as compatible input;
7. reason/recovery text addresses the active host; and
8. the host-neutral core ratchet is limited to persisted interoperability and
   the cross-host risk-path classifier, with a host-selection guard.

`src/integration/review/dispatch/host-neutral-contract.test.ts` adds a minimal,
test-only second host adapter. It imports no OpenCode SDK/adapter/plugin code and
consumes the same mode projection and reviewer instruction contract. This proves
the current semantic contract is consumable outside OpenCode; it does not claim
a supported second host or full cross-host conformance.

`src/adapters/workspace/historical-v5-archive.test.ts` verifies fixed archive
bytes generated once by the V5-capable commit `33efb381`, together with the
matching external audit/state fixture:

- verification passes and reports `review_evidence_historical_transport` as
  informational, not as a rewrite or binding;
- archive tampering fails even when the checksum sidecar is recomputed;
- `isBindableReviewTransport` accepts only V6 with native provenance.

The fixture is genuine output of historical source, not a V6 archive transformed
during the test. It is a deterministic repository fixture, not a customer artifact
from a published release; acceptance against a real customer V1 archive remains
an installed-data item.

Focused reproduction:

```sh
npx vitest run --project integration \
  src/integration/review/dispatch/host-neutral-contract.test.ts
npx vitest run --project unit src/adapters/workspace/historical-v5-archive.test.ts
npx vitest run --project unit src/adapters/session-authority.test.ts
```

## Assurance scope for reviewer result bytes

The receipt now also binds the result observed at FlowGuard's after-hook, and
per-child tails reject the previously reproduced later After/Context changes
(`b9a41e5b`). It does **not** attest the final consumed tool-result
representation. Follow-up native diagnostics reproduce replacement by a later
dynamic context hook and by `http.request` while V6 evidence still fulfills.
These require installed plugin privileges, not merely caller text. Under the
operator's untrusted-co-installed-plugin model they remain R4 blockers, not
trusted-host exclusions; see the [R4 report](./reviewer-tool-result-evidence.md#follow-up-reachable-plugin-residuals-2026-11-03).

FlowGuard therefore must not describe the terminal receipt as proof of the exact
tool-result bytes consumed by the model. A future final-consumption attestation
must bind the representation after host normalization, truncation and transport
mapping; an early implementation-result digest or a later History reread is not
sufficient. Do not add a speculative digest or claim protection against
privileged host plugin code.

## Missing V1 reviewer parity (separate workstream)

These mechanisms remain owners with tests; their V2 integration is partial or absent.
They are parity work inside PR #1190, not additional WS2 host-neutralization.
Each item needs a positive product contract and a fail-closed negative.

| Mechanism                                         | Current owner                                                                                                        | Missing V2 call path                                                                                                                                                       | Required implementation/tests                                                                                                                                                                                                                                                              |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Retry classification and bounded diagnostics      | `src/integration/review/dispatch/capture-retry.ts`                                                                   | `native-review-capture` currently closes every non-provenance failure terminally                                                                                           | Route retryable capture failures through the existing classifier and durable re-arm; test one bounded re-arm on the same frozen obligation, no second child after terminal closure, and exhaustion.                                                                                        |
| Durable re-arm                                    | `src/integration/review/dispatch/durable-dispatch.ts` (`buildInterruptedDispatchRearm`, `abandonAndRearmByHostCall`) | Partial: proven unknown-outcome settlement now reopens, and the typed tool retry uses `buildInterruptedDispatchRearm`; automatic classified capture retry is still unwired | Native fresh-attempt recovery passes; local crash/old-child probes supplement it. Preserve quarantine and exact lineage; complete bounded retry/exhaustion and native concurrent/late-completion coverage, not an automatic unlock.                                                        |
| Incoherent / pre-bind / expired-dispatch closures | `src/integration/review/dispatch/native-review-execution.ts`                                                         | No V2 product caller                                                                                                                                                       | Connect the canonical closure owners to capture settlement; test each closure leaves no invocation and one audit intent, and that a late answer cannot bind.                                                                                                                               |
| Reviewer observation replay                       | `src/integration/review/observations/observation-replay*.ts` + `flowguard_observe_repository`                        | Connected: the enrolled child can execute the sanctioned tool, and native capture replays before binding findings                                                          | Native positive binds a frozen-commit citation; foreign/parent session, revision and content/response-digest substitutions reject. Serialized persistence rechecks lineage and deduplicates. Installed/independent acceptance and R4 remain separate; see the observation follow-up below. |

These rows are the authoritative V2 parity backlog. They must not be marked
done from component tests alone; completion requires the actual product flow on
the pinned host, with the existing Finding 6 recovery proof.

### Observation parity follow-up (2026-11-03)

`plugin.ts` exposes only the existing observation tool (besides inert help) to
the enrolled reviewer child; other delegated agents and parent workflow tools
remain denied. `plugin-native-tools.ts` resolves the parent's workspace but
passes the **actual child** execution identity to the canonical tool. The initial
review receipt controller and result-integrity tails cover this tool too; the
serialization lease still rejects every tool.

`plugin-native-review.ts` resolves exact dispatch/attempt/child lineage, calls
`replayAndPersistObservations`, and rereads authority before capture validation.
The existing replay authority reacquires frozen bytes and verifies capture
session/revision/content/response digests. The serialized persistence mutation
rechecks the created attempt, pending obligation and exact child and deduplicates
against fresh observations, so parallel replay cannot mint duplicate authority.
Pre-bind rejection retains the canonical code/details; it is not silently mapped
to `REVIEW_ATTEMPT_UNAVAILABLE`.

`opencode-reviewer-observation-live.smoke.test.ts` runs the real built product on
OpenCode 2.2.4 with explicitly component-seeded activation and Discovery context.
Its positive cites an observed frozen commit even after the working file changes.
Five negatives substitute foreign/parent session, revision, content or response
digest and require `REVIEW_EVIDENCE_NOT_OBSERVED` with no invocation. These prove
the V2 call chain, not activation provenance or final consumed-representation R4
assurance. Bounded retry/exhaustion and the other terminal closure paths remain
open work in the table above.

```sh
npm run build
OPENCODE_LIVE=1 npx vitest run --project smoke \
  src/cli/opencode-reviewer-observation-live.smoke.test.ts
npx vitest run --project integration \
  src/integration/plugin-native-tools.test.ts \
  src/integration/review/observations/observation-replay.test.ts \
  src/integration/tools/observe-repository.test.ts
```

## Boundaries

- No second host implementation or new general framework is introduced.
- No V1 Task or V5-to-V6 migration shim is reintroduced.
- No merge, force-push, #1191/#1192 change, or whole-PR acceptance follows from
  this closure document.

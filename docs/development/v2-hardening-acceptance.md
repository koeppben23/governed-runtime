# FlowGuard V2 forensic hardening — acceptance evidence

Scope: [#1239](https://github.com/koeppben23/governed-runtime/issues/1239).
This document is an execution checklist, **not** a release certificate.
The benchmark scripts output observations obtained at execution time. A green
workflow does not automatically prove every host/hardware-dependent claim.
The current execution record is maintained in the
[V2 hardening evidence matrix](./v2-hardening-evidence.md).

## Reproducible performance gates

Run against the exact candidate commit and record the commit SHA, Node, Git,
operating system and filesystem in the test report.

```bash
npm ci
npm run build
node scripts/perf/runtime-bootstrap.mjs
node scripts/perf/audit-append-scale.mjs
node scripts/perf/audit-segment-poc.mjs
AUDIT_WRITERS=32 node scripts/perf/audit-concurrent-writers.mjs
node scripts/perf/audit-crash-matrix.mjs
SOAK_ITERATIONS=10000 node scripts/perf/runtime-soak.mjs
FLOWGUARD_STATUS_BENCHMARK=1 npx vitest run --project integration \
  src/integration/tools-execute-status.test.ts -t 'BENCHMARK: compact fast path'
node scripts/perf/audit-clone-append.mjs
```

The append-proof and segmented-journal threat model, external-anchor limit and
downgrade contract are recorded in
[ADR-015](../decisions/015-audit-append-proof-and-segment-journal.md). The
segment PoC is a local proof of concept, not production acceptance.

- **Session authority:** the real Git bootstrap benchmark compares a fresh
  canonical resolution followed by a redundant diagnostic fingerprint probe
  against a fresh resolution that reuses the fingerprint **within the same
  invocation**. It reports p50/p95/p99. No cross-invocation authority cache.
  This is only a bootstrap measurement, not complete native host latency.
- **Compact status:** the opt-in integration test alternates full/compact
  calls, reports p50/p95/p99 and fails below a 3× median speedup. The
  `integration-perf` CI job now executes this gate.
- **Audit writer:** the same-filesystem benchmark measures durable
  full-rewrite vs forced copy-on-write clone+append, including fsync+rename,
  with p50/p95/p99 and a 3× median threshold where forced CoW is supported.
  On unsupported filesystems it reports `NOT_VERIFIED`. This is an isolated
  publication benchmark, **not** end-to-end reconciliation throughput.

## Still required for full #1239 closure

The following require explicit actual execution evidence, linked logs and
reproduction steps. They are **NOT_VERIFIED** unless a subsequent report
records real measurements and successful output:

1. Real OpenCode V2 positive/negative native host smoke with pinned actual Git
   and OpenCode versions on the target platform (CI's installed-host smoke
   is a useful additional gate, not a substitute for all real deployments).
2. Audit/session-state scale at 1,000, 10,000 and 100,000 canonical v3 audit
   entries, with bounded state outbox, memory and valid chain/checkpoint after
   restart and reconciliation.
3. At least 32 independent concurrent writers against one session, checking
   exactly-once outcomes, lock serialization and hash-chain validity.
4. Process `SIGKILL` at each atomic state/audit write window, including
   rename/fsync boundaries, followed by restart, reconciliation and archive
   verification. Never infer this from mock exceptions alone.
5. Multi-hour runtime with repeated real session and reviewer lifecycles,
   monitoring heap/RSS and map cardinality; do not evict active or failed
   governance authority merely to meet a memory ceiling.
6. Signed-off measured before/after results including machine/filesystem
   provenance, p50/p95/p99, failure injection and rollback decision.

## Current execution status (2026-11-16)

| #1239 item                                | Status                              | Evidence                                                                                                                                                                                 |
| ----------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native host smoke                         | **PASS for the local macOS target** | OpenCode 2.2.5, Git 2.39.5, Node 22.22.2/npm 10.9.7; install-verify 11/11, full smoke 86/86, review host contract 102/102, reviewer capabilities 3/3. Other deployments are not claimed. |
| 1k/10k/100k audit scale                   | **PASS**                            | 100k full loop: 7,358.98 s, p50 72.2 ms, p95 125.5 ms, p99 138.0 ms, 77,177,728 bytes, valid chain. 100k depth/restart and 100k outbox checkpoint also pass.                             |
| 32 independent writers                    | **PASS**                            | 32/32 unique IDs, contiguous sequence, valid chain.                                                                                                                                      |
| SIGKILL at every state/audit write window | **PASS for durable phases**         | 24 deterministic phase scenarios: marker, first audit, existing audit, clone fallback and state writes; 0 failures. Clone-only phases are `NOT_VERIFIED` on APFS (`ENOSYS`).             |
| Multi-hour real host soak                 | **NOT_VERIFIED**                    | A 10-minute synthetic soak passed 181,825,000 iterations with bounded maps and RSS 275–281 MB. A real multi-hour host run is still required.                                             |
| CoW-reflink writer throughput             | **BLOCKED / NOT_VERIFIED**          | Local APFS and CI report `ENOSYS`/`ENOTSUP` for the forced clone path. Recovery: run `audit-clone-append.mjs` on a verified reflink-capable filesystem.                                  |
| Signed-off measured report                | **PENDING owner sign-off**          | Local evidence and raw logs are available; owner acceptance is not self-issued.                                                                                                          |

**Decision rule:** #1239 remains open until all items above have real evidence.
A performance threshold missed on a supported system blocks acceptance; a
missing environment must be recorded as `NOT_VERIFIED`, never as `PASS`.

### Remaining closure blockers

The code, CI and local evidence work is complete. Full #1239 closure now
requires only:

1. A real multi-hour OpenCode host run with repeated session and reviewer
   lifecycles, sampled for heap/RSS and map cardinality. The 10-minute synthetic
   soak is not a substitute.
2. Forced CoW-reflink measurements on a filesystem where the Node clone path is
   supported. Local APFS and CI report `ENOSYS`/`ENOTSUP`.
3. Owner sign-off of the measured report. This document intentionally does not
   self-issue acceptance.

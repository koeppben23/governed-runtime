# FlowGuard V2 forensic hardening — acceptance evidence

Scope: [#1239](https://github.com/koeppben23/governed-runtime/issues/1239).
This document is an execution checklist, **not** a release certificate.
The benchmark scripts output observations obtained at execution time. A green
workflow does not automatically prove every host/hardware-dependent claim.

## Reproducible performance gates

Run against the exact candidate commit and record the commit SHA, Node, Git,
operating system and filesystem in the test report.

```bash
npm ci
npm run build
node scripts/perf/runtime-bootstrap.mjs
FLOWGUARD_STATUS_BENCHMARK=1 npx vitest run --project integration \
  src/integration/tools-execute-status.test.ts -t 'BENCHMARK: compact fast path'
node scripts/perf/audit-clone-append.mjs
```

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

**Decision rule:** #1239 remains open until all items above have real evidence.
A performance threshold missed on a supported system blocks acceptance; a
missing environment must be recorded as `NOT_VERIFIED`, never as `PASS`.

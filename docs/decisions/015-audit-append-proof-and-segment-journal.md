# ADR-015: Audit append proof and segment journal

- **Status:** Proposed
- **Date:** 2026-11-15
- **Scope:** `audit.jsonl` append verification, crash recovery and future
  segmented persistence
- **Related:** ADR-007 (persistence consolidation), ADR-009 (review transport),
  `docs/development/v2-hardening-acceptance.md`

## Context

The canonical audit trail is a single `audit.jsonl` file in the audit-chain.v3
format. A writer must not accept a partial line, a foreign session identity, a
replayed event ID or a broken hash chain. The current writer therefore reads,
parses, Zod-validates and hash-verifies the complete trail before every append.

That is correct but scales poorly. On the reference workstation, 5,000
synthetic canonical events took 145.2 s and the last 20 appends averaged
46.9 ms. The dominant costs are repeated parsing, full-chain verification and a
complete-file rewrite. The CoW clone path helps only where the filesystem
supports forced reflinks; Ubuntu CI reports `ENOTSUP` and macOS reports
`ENOSYS`, so the fallback remains the measured path there.

## Threat model

The design distinguishes four cases:

1. **Crash or partial write.** A process dies between temp write, fsync, rename
   or directory fsync. A committed event is either fully present or absent; a
   partial line is never a committed event.
2. **Ordinary concurrent writers.** Multiple FlowGuard processes append to the
   same session. The audit write lock serializes them; the durable activation
   store and event IDs prevent replay.
3. **Unprivileged local tampering.** A process can modify audit/checkpoint files
   between appends. Segment hashes and an append proof detect modification only
   if a trust anchor exists outside the mutable local files.
4. **Privileged local tampering.** A root/administrator attacker can rewrite all
   local files and checkpoints. No local-only scheme can prove integrity against
   that attacker. FlowGuard must either state this limit explicitly or require an
   external append-only/WORM/TSA anchor.

The existing TSA evidence on critical events is an external anchor for those
events. A future segment journal may add periodically TSA-stamped segment heads.
Until that anchor is defined and verified, the guarantee is **tamper-evident
against accidental corruption and non-privileged local modification with a
trusted anchor**, not tamper-proof against a privileged local attacker.

## Decision

### Phase 1 — verified in-process append proof (implemented)

The canonical `audit.jsonl` format remains authoritative and unchanged. The
writer keeps an in-process proof for a session only while all of these hold:

- the file identity (`dev`, `inode`, `size`, `mtime`) is unchanged since the
  last full verification;
- the proof is at most 60 seconds old;
- at most 256 appends have occurred since the last full verification;
- the incoming event ID is not already in the proof.

On a proof hit, the writer reuses the verified last sequence/hash and the
event-ID set, avoiding a full parse and chain verification. Any mismatch,
tamper suspicion, duplicate ID, append failure, stale proof or periodic
re-verification falls back to the existing full read/parse/verify path. The
fallback is never reported as a successful fast path.

The proof is process-local and is never a cross-invocation authority. A second
process changing the file changes its inode/size/mtime and therefore invalidates
the proof. A privileged attacker who rewrites files and restores exact metadata
is outside the Phase-1 guarantee; the periodic full verification bounds the
window only for non-adversarial metadata changes.

### Phase 2 — segmented immutable journal (proposed, not implemented)

The long-term design is a segmented journal:

- fixed-size, immutable segment files containing canonical v3 lines;
- a segment header with segment sequence, previous segment digest, event count,
  first/last event identity and a segment digest;
- a hash-chained manifest/index that is itself versioned;
- a root checkpoint that can be TSA-stamped or copied to an external
  append-only store;
- reader compatibility through concatenation/streaming of segments into the
  canonical v3 event sequence;
- explicit downgrade behavior: older readers either read a compatible
  concatenated view or fail closed with an operator recovery instruction.

Segment rollover makes append bytes O(1) amortized. Read verification is O(1)
for unchanged segments and O(n) only for full archive verification. A simple
cursor/checkpoint without segment digests is insufficient because it cannot
detect retroactive modification of older records.

## Alternatives considered

- **Keep full verification on every append.** Correct but does not meet the
  scale target; 5,000 events already take minutes.
- **Append with `fs.appendFile` and trust the OS.** Fast but reintroduces partial
  trailing records and weakens the existing fail-closed boundary.
- **Checkpoint-only fast path.** Rejected: a local checkpoint can be rewritten
  with the audit file; it does not provide a trust anchor.
- **Pure reflink optimization.** Rejected as the primary answer: unsupported on
  the measured CI and macOS filesystems, and the fallback is slightly slower.

## Consequences

- Phase 1 is a bounded, reversible optimization with no format change.
- Full-chain verification still occurs on first append, cache misses, periodic
  refresh and any integrity error.
- 100,000-event acceptance remains **NOT_VERIFIED** until Phase 2 or an
  equivalent segmented design is implemented and measured.
- No archive, export or recovery reader may depend on the in-process proof.
- The durable audit trail remains the source of truth for archive verification.

## Verification

Measured after Phase 1 on the reference workstation (Node 24.20.0, macOS,
APFS; 200-byte detail for 5,000 and 100-byte for 10,000):

- 5,000 events: 71.8 s total, p50 14.1 ms, p95 17.1 ms, p99 20.1 ms.
- 10,000 events: 158.4 s total, p50 15.9 ms, p95 18.9 ms, p99 21.2 ms.
- 100,000 events: **NOT_VERIFIED**; the full-file rewrite path remains
  O(n) bytes per append on filesystems without forced CoW.

- `scripts/perf/audit-append-scale.mjs` measures 1,000/10,000/100,000 events
  with p50/p95/p99 and bytes written.
- `scripts/perf/audit-segment-poc.mjs` demonstrates partial-tail recovery,
  closed-segment tamper detection and a JSONL downgrade view.
- `scripts/perf/audit-concurrent-writers.mjs` runs independent writer processes
  against one session.
- `scripts/perf/audit-crash-matrix.mjs` kills real append processes after
  deterministic delays and verifies the surviving trail; it does not claim every
  instruction-level fsync/rename boundary.
- `scripts/perf/runtime-soak.mjs` churns 10,000 workspace and reviewer
  lifecycles and asserts bounded map cardinality; real multi-hour host RSS
  acceptance remains separate.
- `scripts/perf/audit-clone-append.mjs` reports `NOT_VERIFIED` where forced CoW
  is unsupported; a green job must not count that as a performance PASS.
- Regression tests must cover: append after a tampered file, duplicate event IDs,
  foreign session IDs, stale proof fallback, concurrent writers, SIGKILL at the
  publish boundaries and archive verification after restart.

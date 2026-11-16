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

- the SHA-256 digest of the complete current JSONL bytes matches the digest
  captured at the last full verification;
- the proof is at most 60 seconds old;
- at most 256 appends have occurred since the last full verification;
- the incoming event ID is not already in the proof's bounded id filter.

On a proof hit, the writer reuses the verified last sequence/hash and a
fixed-size Bloom filter of event IDs, avoiding a full parse and chain
verification. The filter has no false negatives: a filter miss proves that the
ID was never inserted. A filter hit (a real duplicate or a false positive) runs
the exact full parse and replay comparison, so duplicate detection remains
exact. The complete content digest is still computed on every append, so a
change to any byte is detected even if `size`, `mtime`, inode and other metadata
are restored with `utimes`. Any mismatch, tamper suspicion, duplicate ID, append
failure, stale proof or periodic re-verification falls back to the existing full
read/parse/verify path. The fallback is never reported as a successful fast
path, and the full next-file content is resolved lazily only when the reflink
clone path is unavailable.

The proof is process-local and is never a cross-invocation authority. A second
process changing the file changes the content digest and therefore invalidates
the proof.

### Continuity across restarts

The durable `.audit-history` marker is written with temp-file fsync, atomic
rename and parent-directory fsync **before** any audit bytes are published. A
crash between marker persistence and audit publication therefore leaves a
marker without a trail; the next writer rejects that state with an explicit
recovery requirement instead of silently starting a new genesis chain. If the
first publication fails during normal operation, the writer removes the
freshly-created marker only when the audit file is still absent. A marker is
never removed when audit bytes exist, even if the publish reported an fsync or
rename failure after the rename committed.

A missing or empty trail is only treated as genesis when no prior in-process
proof or durable marker exists and the persisted session state carries no audit
evidence. The state check uses only positive publication evidence:
`audit_committed`/`reconciled` outbox operations and a retired
`auditOutboxCheckpoint`. A `state_committed` outbox entry is the pre-audit
hand-off and must not block a legitimate first append.

The marker bounds retained proof memory independently of history length:
64 cached sessions × 128 KiB is about 8 MiB, versus one string per historical
event ID in the previous proof. The full-verification path still builds a
transient exact duplicate set, which is released before the proof is stored.

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
  refresh and any integrity error. Content hashing remains O(n) per append while
  a proof is active; that read/hash cost is the security price for detecting
  byte changes independently of filesystem metadata.
- `.audit-history` is a local continuity marker, not audit evidence and not part
  of archive contents. It is durable before the audit bytes, so a crash can only
  produce a false positive (explicit recovery after a marker-only crash), never
  a silent reset after an audit commit. Published outbox state is the second
  safeguard for pre-marker sessions.
- 100,000-event acceptance remains **NOT_VERIFIED** until Phase 2 or an
  equivalent segmented design is implemented and measured.
- No archive, export or recovery reader may depend on the in-process proof.
- The durable audit trail remains the source of truth for archive verification.

## Verification

Measured after Phase 1 on the reference workstation (Node 24.20.0, macOS,
APFS; 100-byte detail):

- 1,000 events: 12.7 s total, p50 12.6 ms, p95 14.8 ms, p99 17.4 ms.
- 5,000 events: 78.4 s total, p50 15.2 ms, p95 19.9 ms, p99 38.0 ms.
- 10,000 events: 183.7 s total, p50 18.0 ms, p95 23.1 ms, p99 31.3 ms.
- 10,000-event history depth: first append 112.2 ms, cached p50 22.1 ms,
  7.7 MB rewritten per append.
- 100,000-event history depth: first append 872.9 ms, cached p50 132.7 ms,
  77.2 MB rewritten per append; the retained id filter remains 128 KiB.
- A 100,000-record append loop is **NOT_VERIFIED**; seeding plus measured
  appends at that depth proves the per-append O(n) read/hash/rewrite cost, not
  the time to perform every rewrite.
- Retained memory: 10,000 events across two cached sessions added 0.2 MB of
  heap and retained 256 KiB of id filters (structural cap 8 MiB). RSS
  high-water grows with transient full-file buffers and is not the retained
  proof.

- `scripts/perf/audit-append-scale.mjs` measures 1,000/10,000/100,000 events
  with p50/p95/p99 and bytes written.
- `scripts/perf/audit-append-depth.mjs` seeds a canonical chain once and measures
  the first and cached append cost at 10,000/100,000 history depth without
  performing the full O(n²) loop.
- `scripts/perf/audit-segment-poc.mjs` demonstrates partial-tail recovery,
  closed-segment tamper detection and a JSONL downgrade view.
- `scripts/perf/audit-concurrent-writers.mjs` runs independent writer processes
  against one session.
- `scripts/perf/audit-crash-matrix.mjs` kills real append processes after
  deterministic delays, verifies the surviving trail, and kills one child exactly
  between durable marker persistence and audit publication through a
  `diagnostics_channel` observation seam. It does not claim every
  instruction-level fsync/rename boundary.
- `scripts/perf/audit-cache-memory.mjs` (`node --expose-gc`) verifies that every
  cached session retains exactly one 128 KiB id filter and reports heap/RSS
  deltas for multi-session histories.
- `scripts/perf/runtime-soak.mjs` churns 10,000 workspace and reviewer
  lifecycles and asserts bounded map cardinality; real multi-hour host RSS
  acceptance remains separate.
- `scripts/perf/audit-clone-append.mjs` reports `NOT_VERIFIED` where forced CoW
  is unsupported; a green job must not count that as a performance PASS.
- Regression tests must cover: append after a tampered file, duplicate event IDs,
  foreign session IDs, stale proof fallback, concurrent writers, SIGKILL at the
  publish boundaries and archive verification after restart.

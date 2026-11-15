# FlowGuard V2 hardening evidence matrix

- **Base:** `develop` @ `836f3cba`
- **Branch:** `integration/v2-forensic-hardening`
- **Environment:** Apple M4 Pro, 48 GB, macOS 27.0.1, APFS, Node 24.20.0
  (Node 22.22.2/npm 10.9.7 for install/smoke gates)
- **Status:** execution record, not a release certificate.

| Invariant / gate                      | Command / source                                                  | Result                     | Raw evidence                                                                                             |
| ------------------------------------- | ----------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------- |
| Audit append, 1,000 events            | `AUDIT_SCALE_COUNTS=1000`                                         | **PASS**                   | 13.6 s; p50 13.2 ms, p95 17.0 ms, p99 21.8 ms                                                            |
| Audit append, 5,000 events            | inline scale run                                                  | **PASS**                   | 71.8 s; p50 14.1 ms, p95 17.1 ms, p99 20.1 ms                                                            |
| Audit append, 10,000 events           | `AUDIT_SCALE_COUNTS=10000`                                        | **PASS**                   | 158.4 s; p50 15.9 ms, p95 18.9 ms, p99 21.2 ms                                                           |
| Audit append, 100,000 events          | not executed                                                      | **NOT_VERIFIED**           | full-file rewrite remains O(n) bytes without forced CoW                                                  |
| 32 independent writers                | `AUDIT_WRITERS=32 node scripts/perf/audit-concurrent-writers.mjs` | **PASS**                   | 32 events, 32 IDs, contiguous sequence, valid chain, 1.48 s                                              |
| Real SIGKILL matrix                   | `node scripts/perf/audit-crash-matrix.mjs`                        | **PASS (time-based)**      | 5/5 valid; 100/101 complete events; every instruction-level fsync/rename boundary still **NOT_VERIFIED** |
| Forced CoW clone                      | `node scripts/perf/audit-clone-append.mjs`                        | **NOT_VERIFIED**           | local `ENOSYS`; CI `ENOTSUP`/`ENOSYS`; fallback measured at 0.94x                                        |
| Segment PoC recovery/tamper/downgrade | `node scripts/perf/audit-segment-poc.mjs`                         | **PASS**                   | partial tail recovered; tamper detected; JSONL downgrade view 10/10                                      |
| Full status latency                   | real repo status harness                                          | **PASS**                   | full 168.7 ms p50 (was 207.5); compact 21.2 ms; focused 18.6 ms                                          |
| Compact status skips probes/drift     | `tools-execute-status.test.ts` + benchmark                        | **PASS**                   | explicit `not_checked`; 3x CI gate passed                                                                |
| Workspace/reviewer lifecycle soak     | `SOAK_ITERATIONS=10000 node scripts/perf/runtime-soak.mjs`        | **PASS**                   | maps bounded at 0 active / 4,096 identity cap; RSS ~103 MB                                               |
| Multi-hour host soak                  | not executed                                                      | **NOT_VERIFIED**           | no real-host RSS/heap duration evidence                                                                  |
| Reviewer settlement retention         | `opencode-governance*.test.ts`                                    | **PASS**                   | full dispatch objects released; bounded identity bindings preserve enrollment/quarantine                 |
| Concurrent `session.deleted`          | `plugin-validation-resume.test.ts`                                | **PASS**                   | exactly-once retirement under interleaving                                                               |
| Enrollment waiter timeout             | `opencode-governance.test.ts`                                     | **PASS**                   | empty waiter map entry removed                                                                           |
| Unit/integration tests                | `npm test`                                                        | **PASS**                   | 478 unit files / 8,771 tests; 270 integration files / 4,718 tests                                        |
| Coverage                              | `vitest --coverage --maxWorkers=2`                                | **PASS**                   | lines 91.99%, statements 90.45%, functions 94.67%, branches 83.92%                                       |
| Unit PERF                             | `npm run test:unit:perf`                                          | **PASS**                   | 55 tests                                                                                                 |
| Integration PERF                      | `npm run test:integration:perf`                                   | **PASS**                   | 13 tests                                                                                                 |
| Architecture                          | `npm run test:architecture`                                       | **PASS**                   | 53 files / 554 tests                                                                                     |
| Scripts / fuzz / conformance          | `test:scripts`, `test:fuzz`, `test:assertion-conformance`         | **PASS**                   | 349 / 39 / 112 tests                                                                                     |
| Build / docs / lint / format          | `npm run build`, `check:doc-drift`, `lint:strict`, `check:format` | **PASS**                   | CI and local                                                                                             |
| Install verify                        | Node 22.22.2 / npm 10.9.7 `test:install-verify`                   | **PASS**                   | 11/11                                                                                                    |
| Full smoke                            | Node 22.22.2 / npm 10.9.7 `test:smoke`                            | **PASS**                   | 12 files / 86 tests, 25 skipped                                                                          |
| Reviewer capability smoke             | `OPENCODE_LIVE=1 test:opencode-reviewer-capabilities`             | **PASS**                   | 3/3 on OpenCode 2.2.5                                                                                    |
| Host pin                              | `npm run check:opencode-host`                                     | **PASS**                   | installed `opencode v2.2.5`                                                                              |
| Mutation                              | targeted `persistence-audit.ts` Stryker run                       | **PENDING / NOT_VERIFIED** | full mutation result not yet recorded in this matrix                                                     |
| Dependency audit                      | `npm audit --omit=dev`                                            | **OPEN**                   | 29 moderate, 0 high/critical                                                                             |
| Historical V1 archive verification    | architecture guards + v5 tests                                    | **PASS**                   | v5 remains archive-only, not bindable                                                                    |

`NOT_VERIFIED` is not a PASS. The branch must not be merged to `develop`
until the owning acceptance decision explicitly accepts the remaining items.

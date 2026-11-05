# PR #1190: ISO publication and performance diagnosis

Status: Draft / NO-GO. These checks do not establish installed Desktop acceptance,
reviewer integrity, R4 containment or complete workflow acceptance.

## Failed hosted evidence

CI run `42005224804`, source `0c064dd336988e3989ab7600e526ebfcaa3fb7f9`, failed
unit, coverage and integration-perf. Unit and coverage observed both publishers
claiming the same final directory with `/bin/mkdir`, exit 0 and identical inode.
The runner logs identify Ubuntu 26.04.1, image `20261025.179.1`; they did **not**
record the mkdir binary version. A PATH-inherited fake does not explain those
native-binary observations.

Separate perf failures were 182.796389 ms against `<150 ms` for 1,000 native
non-mutating completions and 11.993885 ms against `<10 ms` for the tool property
loop. No threshold, coverage selection or governance assertion is waived.

## Reproduction before changing production

The exact Git source was archived into disposable Linux containers with native
`/work` and `/tmp` storage (not macOS bind-mounted report directories), Node
22.22.2 and npm 10.9.7. The unchanged ISO suite ran under `strace -ff`, tracing
exec, mkdir, unlink, rename and process creation.

| Environment                                    | Observed result                                                            |
| ---------------------------------------------- | -------------------------------------------------------------------------- |
| Debian bookworm / GNU coreutils 9.1 / arm64    | All 12 unchanged ISO tests passed                                          |
| Ubuntu 26.04 / uutils coreutils 0.10.0 / arm64 | Original uninstrumented concurrency test failed `[0, 0]`; 11 others passed |

Ubuntu base digest:
`sha256:6a06111c3b0a8600feadb270aec771dc239bf407b25625f93f44ab00e11f4d3c`.
The losing utility's trace (PID 582) was:

```text
execve("/usr/bin/mkdir", ["mkdir", ".../reports/ses_demo123"], ...) = 0
mkdirat(AT_FDCWD, ".../reports/ses_demo123", 0777) = -1 EEXIST (File exists)
+++ exited with 0 +++
```

The winner (PID 583) called `mkdirat` on the same target successfully and also
exited 0. Both wrappers then moved reports into that directory. The traced case
passing in this run does not negate the original case's syscall evidence.

This matches [Ubuntu #2171333](https://bugs.launchpad.net/ubuntu/+source/rust-coreutils/+bug/2171333)
and upstream fix
[`bf423f388d543b9180db6b7283d82b301f138913`](https://github.com/uutils/coreutils/commit/bf423f388d543b9180db6b7283d82b301f138913).
**NOT_VERIFIED:** the exact failed CI binary/version; the local environment is
arm64, not the hosted x86 runner. The reproduction establishes this concrete
failure mechanism, not the cause of every historical timing or publication run.

## Bounded correction

`run-iso-mapping.sh` reserves the final directory through Node's non-recursive
`fs.mkdirSync`, surfacing kernel failure instead of trusting utility success.
The existing CLI resolution, export/report validation, staging cleanup and
refusal to overwrite remain. Moving two companion files remains non-crash-atomic.

The test preload intercepts only the final Node call, rendezvous-schedules both
publishers and invokes the original filesystem operation. It verifies exactly
one `EEXIST` loser, one winner, identical parent/inode, winner identity in both
reports and absence of leftover staging. A deliberately broken external mkdir
would accept an existing directory; the test proves it is not used as ownership
authority. Denied Node reservation must fail closed and clean staging.

Raw local evidence is retained in the session temporary directory
`1190-linux-ci-diagnostic-P0mg7s` (Debian root and separate `ubuntu26/`), including
source archive, Dockerfiles, logs and syscall traces. Those local files are not
published acceptance artifacts.

The first corrected-wrapper container run passed all 14 ISO cases, including
the deliberately broken external-utility regression's old-owner negative
control (both original publishers returned 0). Its subsequent PERF invocation
was invalid: the local overlay archive contained macOS AppleDouble files that
matched the test glob, and a newly duplicated benchmark import failed parsing.
The duplicate import was removed and the diagnostic overlay export corrected
to omit macOS metadata; that first invocation is not a passing PERF result.

The corrected diagnostic export (`ubuntu26-fixed-v2/`) then passed all **14 ISO
tests** under strace and the full **13 selected PERF tests** (250 files / 4,414
discovered tests; unchanged selection). The old-wrapper negative control failed
specifically with two status-0 publishers, not a setup/parse error. macOS also
passed the 14 ISO cases and both affected integration suites (101 tests).

Local source binding for that Linux run (SHA-256):

- Original `0c064dd3` Git archive:
  `a365a5ba585e7ad4d6e82d721246dab74b80c6097609df31b0c412ea3b2af62f`.
- Five-file correction overlay (wrapper, ISO test, two integration tests and
  `package.json`):
  `5e7051cae63aaac14224d425124db0c94bbf92ce1c8f7988b8b6f2d0274d550b`.

These are source/diagnostic archives, not installed package acceptance evidence.

The full local integration suite subsequently passed **4,414 tests**. The first
full normal run passed **12,922 tests** with two skipped and one failure: the
documentation contract still required the old literal `mkdir "$FINAL"`. That
guard now requires the non-recursive Node claim and rejects the shell claim;
the behavioral concurrency assertions were not relaxed.

After that guard correction, the complete normal gate passed **12,923 tests / 2
skipped** across 705 files (105.34 s). The focused wrapper/documentation gate
passed 19 tests; the two affected integration suites passed 101 tests. Type
checks, strict lint, format, build/doc-drift and 554 architecture tests passed.
This is local source verification, not final-SHA hosted or installed acceptance.

## Separate performance evidence and measurement correction

Diagnostic-only instrumentation recorded wall/CPU time without changing the
original measured sample or assertions. Debian and Ubuntu two-file serial runs
passed: native warm batches were roughly 32–37 ms; the property loop settled
from roughly 0.5–0.8 ms to 0.1–0.15 ms after JIT warmup. CPU profiles include
journal/digest verification, structured-clone fixture storage and garbage
collection; these checks were not removed or cached away.

The full 250-file / 4,414-test PERF selection was then run in Ubuntu with two
container CPUs, first with default workers and CPU profiling, then one worker:
both passed the same 13 selected tests. Native batches were 47.75/36.64/31.25/32.67
ms and 46.98/34.77/31.54/29.15 ms respectively. The first property loop was 3.46 ms
and 0.60 ms, with warm samples near 0.1 ms. This is not a failed/passed controlled
reproduction of the hosted miss; profiling and scheduling also differ.

The bounded correction uses the existing warm benchmark helpers: p99 at the same
`<10 ms` for the full property-access workload and p99 over three measured native
1,000-callback batches at the same `<150 ms`, rather than a minimum. All native
authority checks remain. One file worker bounds competition without narrowing
the PERF selection or changing CI's execution budget. The property test is named
for what it actually measures; it is not proof of side-effect-free module import.

**NOT_VERIFIED:** the exact scheduling/JIT contribution to the failed hosted
timings. A passing local comparison is not a flake designation or final hosted
certification. Current-source hosted verification remains required.

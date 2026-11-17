# Onboarding Acceptance

This record measures the documented first local run on a fresh clone. It is
environment-bound evidence, not a guarantee for every machine or network.

## Measured path

The smoke run follows the documented path in the
[Development Guide](./index.md#first-local-run):

1. fresh clone from the public repository,
2. Node exactly `22.22.2` from `.node-version`,
3. empty npm cache,
4. `npm ci`,
5. `npm run check`,
6. `npm test`.

The 15-minute target is accepted only when the measured total is at most
`15:00`. A slower result keeps the guide's neutral target wording; it is never
reported as a pass.

## Reproduce

From this repository, with Node `22.22.2` active:

```bash
npm run onboarding:smoke -- \
  --repo https://github.com/koeppben23/governed-runtime.git \
  --ref <branch-or-tag> \
  --expected-sha <full-40-character-sha>
```

`--expected-sha` fails closed before installation if the branch moved to a
different commit. A run without it is exploratory and cannot be used as an
acceptance record. The script prints a Markdown report with wall-clock timings,
exit codes, and environment data. Pass `--with-build` to measure the separate
debugging build. The script does not modify this repository and is not a
required CI gate.

## Acceptance record

| Date       | Commit    | OS                          | Node / npm       | Clone | npm ci | check | test | Total | Result |
| ---------- | --------- | --------------------------- | ---------------- | ----- | ------ | ----- | ---- | ----- | ------ |
| 2026-11-17 | `3767310` | macOS 27.0.1 / darwin arm64 | 22.22.2 / 10.9.7 | 0:09  | 0:47   | 0:03  | 2:11 | 3:10  | PASS   |

Measured commit (full):
`3767310a984cdc2f0bda908f9e9d9edbb2d481a8`. The run used
`--expected-sha` with that exact value; the SHA check passed before installation.
Earlier onboarding measurements were 3:09 at `5ddf0dc6` and 3:02 at `2538a130`.

The measured target path completed in 3:10 on an Apple Silicon Mac with an
empty npm cache and a full clone. The separate `npm run build` took 0:02 and is
not included in the target total. The 15-minute target is therefore supported
for this environment, not for every machine or network.

This measured head includes the time-boxed audit-exception control. The only
commit after it adds this evidence record. A post-merge audit re-runs the smoke
against the merged `develop` tree if that tree differs from the measured commit.

### Observed flake

The first fresh-clone attempt failed in
`src/integration/plugin-native-review-capture.test.ts` at
`serializes concurrent capture completions exactly once` with zero recorded
invocations. The same test file passed when the complete file was run, and the
second fresh-clone attempt passed. The filtered single test fails in isolation,
which indicates test-order or concurrency sensitivity rather than a change in
this PR. The 15-minute PASS above is therefore not a claim that the full suite
is order-independent, and this record claims one successful first run rather
than a guaranteed success rate. A separate follow-up is required to stabilize
that test.

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
  --ref <branch-or-tag>
```

The script prints a Markdown report with wall-clock timings, exit codes, and
environment data. Pass `--with-build` to measure the separate debugging build.
The script does not modify this repository and is not a required CI gate.

## Acceptance record

| Date       | Commit  | OS      | Node / npm | Clone | npm ci | check | test | Total | Result  |
| ---------- | ------- | ------- | ---------- | ----- | ------ | ----- | ---- | ----- | ------- |
| 2026-11-17 | pending | pending | pending    | —     | —      | —     | —    | —     | pending |

The final row is replaced with the measured result from the pull-request head.
A post-merge audit re-runs the measurement against the merged `develop` tree if
that tree differs from the measured commit.

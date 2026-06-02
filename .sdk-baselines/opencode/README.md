# OpenCode SDK Baseline

**Do not edit these files manually.**

These files are snapshots of the `@opencode-ai/plugin` type definitions at the
pinned version. They are compared against the installed version in CI to detect
SDK type drift.

OpenCode host/Desktop compatibility is tracked separately through the
`opencode-ai` package. Official OpenCode docs describe `opencode upgrade` and
startup autoupdate behavior; CI disables autoupdate with
`OPENCODE_DISABLE_AUTOUPDATE=1` so host tests run against the pinned package
version recorded in `host-version.json`.

| File                | Source                                             |
| ------------------- | -------------------------------------------------- |
| `plugin-index.d.ts` | `@opencode-ai/plugin/dist/index.d.ts`              |
| `plugin-tool.d.ts`  | `@opencode-ai/plugin/dist/tool.d.ts`               |
| `host-version.json` | OpenCode Desktop/host package compatibility target |
| `docs-hashes.json`  | Hash baseline for OpenCode documentation sections  |

## Updating the baseline

```bash
node scripts/sdk-type-snapshot.mjs --update
npm run update:opencode-sdk -- <sdk-version> <opencode-host-version>
node scripts/docs-drift.mjs --update
```

## Desktop update signal

After accepting an OpenCode Desktop update locally, check whether the local host
version is newer than this repository's host baseline:

```bash
npm run check:opencode-host
```

If drift is detected, trigger the governed GitHub workflow instead of changing
baselines locally:

```bash
npm run trigger:opencode-host-update
```

The trigger only starts `opencode-sdk-update.yml`; the workflow remains the
authority that regenerates baselines and opens a PR after CI gates pass.

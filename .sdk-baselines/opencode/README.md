# OpenCode SDK Baseline

**Do not edit these files manually.**

These files are snapshots of the `@opencode-ai/plugin` type definitions at the
pinned version. They are compared against the installed version in CI to detect
SDK type drift.

| File                | Source                                            |
| ------------------- | ------------------------------------------------- |
| `plugin-index.d.ts` | `@opencode-ai/plugin/dist/index.d.ts`             |
| `plugin-tool.d.ts`  | `@opencode-ai/plugin/dist/tool.d.ts`              |
| `docs-hashes.json`  | Hash baseline for OpenCode documentation sections |

## Updating the baseline

```bash
node scripts/sdk-type-snapshot.mjs --update
node scripts/docs-drift.mjs --update
```

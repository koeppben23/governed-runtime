# Native OpenCode V2 API Baselines

Generated declarations must be updated through `scripts/sdk-type-snapshot.mjs`.
Active baselines pin exact `@opencode/plugin` and `@opencode/client` packages,
not installed Desktop/CLI behavior or operator/reviewer assurance.

| Files                                                        | Contract                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `plugin-{index,plugin,tool,session,event,registration}.d.ts` | Native Promise plugin definition, context, registrations and hooks       |
| `client-event-contract.d.ts`                                 | `EventSubscribeOutput`, `V2Event`, member payloads and structured errors |
| `client-message-contract.d.ts`                               | Raw session messages, native tool states/content and structured errors   |
| `schema-tool.d.ts`                                           | Plugin tool context, result/content and error schema declarations        |
| `version.json`                                               | Exact plugin/client package versions and normalized declaration hashes   |
| `host-version.json`, `docs-hashes.json`                      | Retained old-generation host/docs baseline; **not V2 certification**     |

```bash
node scripts/sdk-type-snapshot.mjs
npm run update:opencode-sdk -- <V2-version-or-tag>
```

The update command requires matching native plugin/client releases and uses
`npm install` to synchronize exact pins and the lockfile. It does not update
host support constants, product versions, documentation tags, or historical
probe bytes. A host-version argument is rejected. Missing package metadata
fails explicitly; no `unknown` version or latest-SDK comparison bypass exists.

Scheduled API-candidate checks regenerate a candidate baseline and run contract
and regression checks; changing those declarations is not proof of installed
host behavior. The API update workflow opens a **Draft** PR, never certifies a
host or closes operator/reviewer acceptance gates.

`check:opencode-host` validates `cli-candidate.json` and compares the exact native
CLI version output; it does not certify ACTIVE product or Desktop support.
`OPENCODE_CLI` may name the executable, but cannot change the expected version.
The obsolete host-update trigger was removed; API updates never adopt a host.

**V2 documentation drift: NOT_VERIFIED.** No verified revisions/document set/hash
contract has been adopted for V2 docs. `docs-drift.yml` is manual historical V1
integrity only, not scheduled or part of V2 acceptance. Its explicit command is
`node scripts/docs-drift.mjs --historical --verbose`; unqualified invocation fails
with `NOT_VERIFIED`. Historical baseline bytes cannot be rewritten by the tool.
A historical match never implies V2 documentation coverage or SDK compatibility.
Investigate changed bytes against the original tag commit as an integrity issue;
the API-only SDK updater does not update this host pin or docs evidence.
See `docs/host-probes/opencode-v2/` for separately scoped acceptance gates.

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

Installed-host detection/smoke infrastructure still needs its own V2 acceptance
work. `check:opencode-host` compares only the retained old-generation baseline;
`trigger:opencode-host-update` explicitly blocks instead of dispatching a host
target to the API-only updater. Neither path certifies V2 Desktop/CLI support.
See `docs/host-probes/opencode-v2/` for the current NO-GO gates.

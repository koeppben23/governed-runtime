# Ignored reference shapes

Globs and placeholders: `src/**/*.ts`, `src/state/evidence-*.ts`,
`docs/architecture/schema-*.md`, `<path>`, `{ file, owner }`.

URLs: `https://example.com/src/not-checked.ts`, `https://github.com/x/y/src/z.ts`.

Module specifiers and bare identifiers: `./sibling.js`, `../parent.js`,
`createFlowGuardPluginHooks()`, `stateSerializeMs`.

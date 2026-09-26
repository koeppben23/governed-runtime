# Citation validation fixture

- valid symbol `src/integration/audit-outbox.ts:prepareStateWithAuditOperations()`
- missing symbol `src/integration/audit-outbox.ts:definitelyNotASymbol()`
- valid range `src/integration/audit-outbox.ts:10-20`
- invalid range `src/integration/audit-outbox.ts:99999`
- valid anchor `src/integration/audit-outbox.ts#L10-L20`
- invalid anchor `src/integration/audit-outbox.ts#L99999`
- unsupported method `src/integration/audit-outbox.ts:SomeClass.method()`
- unsupported bare `src/integration/audit-outbox.ts:noParens`
- unsupported symbol on markdown `docs/testing-strategy.md:someSymbol()`
- unsupported citation on a directory `src/integration:12`

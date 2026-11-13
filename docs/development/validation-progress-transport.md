# Validation progress display

## Scope

FlowGuard publishes the existing model-free check display only during the two
validation phases:

- `VALIDATION`: baseline checks after plan approval and before `/implement`.
- `IMPL_VALIDATION`: post-implementation checks after `/implement`.

No other phase, command or workflow is included. The display is not a validation
result, review verdict or approval authority.

## Transport

`src/integration/plugin-presentation.ts` keeps a bounded, in-memory page per
session. `autoValidationProgress` receives `starting`, `check_started`,
`check_finished` and `finished` events bound to the current system-work
operation and run; superseded operations and post-closure events are rejected.
The callback is non-blocking: a failing or hanging presentation consumer never
delays a check.

The Desktop side reads the page through the read-only `GetPresentation` RPC and
invalidates it on `PresentationUpdated`. The chat card filters both phases to
`VALIDATION` and `IMPL_VALIDATION`; the existing status reconciler remains
separate.

## Invariants

- No `session.prompt` or `session.synthetic` is created for progress.
- No model request or extra user turn is added.
- Presentation events are ephemeral and never appear as audit or validation
  evidence.
- The existing canonical status, controls and decision surfaces are unchanged.

## Verification

- `src/integration/plugin-presentation.test.ts`
- `src/integration/auto-validation.test.ts`
- `src/cli/gui-plugin-bundle.test.ts`
- `src/integration/plugin-v2.test.ts`

Installed Desktop rendering and packed-product acceptance remain
`NOT_VERIFIED`.

/**
 * @module shared/gate-decision
 * @description Structural authority for allow/deny decisions.
 *
 * A denial without `code` and `reason` is not representable: a consumer that
 * narrows on `allowed === false` receives both fields as required `string`s from
 * the compiler — no non-null assertions, no fallback codes. Allowed decisions
 * cannot carry concrete denial metadata.
 *
 * Compiler note: with `exactOptionalPropertyTypes` enabled (`tsconfig.json`),
 * an allowed decision cannot spell out `code: undefined` or `reason: undefined`,
 * and a concrete denial code is forbidden regardless.
 *
 * Type-only module: no runtime behavior, no validation logic.
 *
 * @version v1
 */

/** A decision that allows the action. Concrete denial metadata is forbidden. */
export interface AllowedDecision {
  readonly allowed: true;
  readonly code?: never;
  readonly reason?: never;
}

/** A decision that denies the action: `code` and `reason` are mandatory. */
export interface DeniedDecision<Code extends string = string> {
  readonly allowed: false;
  readonly code: Code;
  readonly reason: string;
}

/** Discriminated allow/deny decision. */
export type GateDecision<Code extends string = string> = AllowedDecision | DeniedDecision<Code>;

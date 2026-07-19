/**
 * @module cli/parse-result
 * @description Shared discriminated-union parse-result contract for all CLI parsers.
 */

/** Successful parse with the resolved value. */
export type CliParseOk<T> = { kind: 'ok'; value: T };

/** User requested --help or -h. Caller should print usage and exit 0. */
export type CliParseHelp = { kind: 'help' };

/** Parse error. Caller should emit error to stderr and exit 2. */
export type CliParseError = { kind: 'error'; error: string; hint?: string };

/** Discriminated union returned by every CLI parser. */
export type CliParseResult<T> = CliParseOk<T> | CliParseHelp | CliParseError;

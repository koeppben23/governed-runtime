/**
 * @module integration/risk-path-extraction
 * @description Best-effort extraction of the file paths a mutating host tool
 * will touch before it runs (write/edit, apply_patch, bash) plus the
 * conservative "is this bash command provably covered?" predicate.
 *
 * Provisional scope only: extraction never replaces the final git re-check.
 *
 * @version v1
 */

import * as path from 'node:path';

export function targetPathsForRisk(
  toolName: string,
  args: Record<string, unknown>,
  getWorktreeRoot: () => string | undefined,
): string[] {
  if ((toolName === 'write' || toolName === 'edit') && typeof args.filePath === 'string') {
    return [resolveRelativePath(args.filePath, getWorktreeRoot)];
  }
  if (toolName === 'apply_patch') {
    const patch = typeof args.patchText === 'string' ? args.patchText : args.diff;
    if (typeof patch === 'string') return extractPathsFromPatch(patch);
  }
  if (toolName === 'bash' && typeof args.command === 'string') {
    return extractPathsFromBashCommand(args.command);
  }
  return [];
}

// ─── Path Resolution Helper ──────────────────────────────────────────────────

function resolveRelativePath(filePath: string, getWorktreeRoot: () => string | undefined): string {
  const rootPath = getWorktreeRoot();
  const worktreeRoot = rootPath === undefined ? null : path.resolve(rootPath);
  const resolved = path.resolve(filePath);
  if (worktreeRoot && resolved.startsWith(`${worktreeRoot}${path.sep}`)) {
    // Normalize to forward slashes for platform-independent audit output.
    return path.relative(worktreeRoot, resolved).replace(/\\/g, '/');
  }
  return filePath;
}

// ─── apply_patch Path Extraction ─────────────────────────────────────────────

/**
 * Extract target file paths from a unified diff string.
 * Parses `--- a/path` and `+++ b/path` headers, filters `/dev/null`.
 *
 * @internal
 */
function collectPathsFromPattern(
  diff: string,
  pattern: RegExp,
  groupIndexes: number[],
  paths: Set<string>,
): void {
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(diff)) !== null) {
    for (const idx of groupIndexes) {
      const filePath = (match[idx] ?? '').trim();
      if (filePath && filePath !== '/dev/null' && filePath !== 'dev/null') {
        paths.add(filePath.replace(/\\/g, '/'));
      }
    }
  }
}

export function extractPathsFromPatch(diff: string): string[] {
  if (diff.length > 1024 * 1024) return [];
  const paths = new Set<string>();
  collectPathsFromPattern(diff, /^(?:---|\+\+\+)[ \t]+(?:[ab]\/)?([^\n\r]+)$/gm, [1], paths);
  collectPathsFromPattern(diff, /^Binary files a\/(.+?) and b\/\1 differ$/gm, [1], paths);
  collectPathsFromPattern(diff, /^diff --git a\/(.+?) b\/(.+)$/gm, [1, 2], paths);
  collectPathsFromPattern(diff, /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm, [1], paths);
  // `*** Move to:` relocates an updated file to a new (possibly higher-risk) path.
  collectPathsFromPattern(diff, /^\*\*\* Move to: (.+)$/gm, [1], paths);
  return [...paths];
}

// ─── bash Command Path Extraction ────────────────────────────────────────────

/**
 * Best-effort extraction of file paths from bash command strings.
 * Handles common patterns: redirects, tee, rm, mv, cp, sed -i, chmod, git checkout --.
 *
 * Returns [] for unparseable commands (fail-safe: unknown ≠ "no risk").
 *
 * @internal
 */
export function extractPathsFromBashCommand(cmd: string): string[] {
  // Guard against excessive input that could cause ReDoS.
  if (cmd.length > 1024 * 1024) return [];

  const paths = new Set<string>();

  // 1. Redirect targets: >, >>, 2>, 2>>
  const redirectPattern = /(?:^|[^<])(?:2?>?>|>)\s*["']?([^\s"'|;&><]+)["']?/g;
  let match: RegExpExecArray | null;
  while ((match = redirectPattern.exec(cmd)) !== null) {
    const target = match[1] ?? '';
    if (target && !target.startsWith('/dev/')) {
      paths.add(target);
    }
  }

  // 2. tee targets: | tee [-a] <file> [<file> ...] — every operand counts.
  collectArgsToPaths(cmd, /\|\s*tee\s+([^\n;&|>]+)/g, paths);

  collectArgsToPaths(cmd, /\brm\s+(?:-[rRfiv]+\s+)*([^\n;&|]+)/g, paths);
  collectArgsToPaths(cmd, /\b(?:mv|cp)\s+(?:-[a-zA-Z]+\s+)*([^\n;&|]+)/g, paths);
  collectArgsToPaths(
    cmd,
    /\bsed\s+(?:(?:-[^i\s]+\s+)*-i[^\s]*(?:\s+-[^i\s]+)*|-[a-zA-Z]*i[^\s]*)(?:\s+-[^i\s]+)*\s+(?:'[^']*'|"[^"]*"|[^\s]+)\s+([^\n;&|]+)/g,
    paths,
  );
  collectArgsToPaths(
    cmd,
    /\bchmod\s+(?:-[Rfvch]\s+)*(?:[0-7]{3,4}|[ugoa]?[+\-=/][rwxXst]+)\s+([^\n;&|]+)/g,
    paths,
  );
  collectArgsToPaths(cmd, /\bgit\s+checkout\s+(?:[^\s]+\s+)?--\s+([^\s;&|]+)/g, paths);

  return [...paths].map((p) => p.replace(/\\/g, '/'));
}

function collectArgsToPaths(cmd: string, pattern: RegExp, paths: Set<string>): void {
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(cmd)) !== null) {
    for (const arg of splitUnquotedArgs((match[1] ?? '').trim())) {
      if (!arg.startsWith('-')) paths.add(arg);
    }
  }
}

/**
 * Split a string into arguments, respecting single/double quotes.
 * @internal
 */
function splitUnquotedArgs(input: string): string[] {
  const args: string[] = [];
  const pattern = /(?:"([^"]*)")|(?:'([^']*)')|([^\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(input)) !== null) {
    const arg = m[1] ?? m[2] ?? m[3] ?? '';
    if (arg) args.push(arg);
  }
  return args;
}

/** Unquoted characters that make the command's target set unprovable. */
const UNPROVEN_UNQUOTED = new Set(['`', '$', '<', ';', '\n']);

/**
 * Commands whose only file writes are captured by the extractor:
 * - output-only builtins (stdout/redirect only),
 * - read-only filters and inspectors without file-write options (`sort -o`,
 *   `awk system(...)`, `env <cmd>`, scripted `sed w` are NOT known),
 * - tools whose path arguments the extractor parses (`rm`, `mv`, `cp`, ...).
 * Anything else (interpreters, package managers, build tools, scripts) may
 * write arbitrary files and is never "provably known", even with a redirect.
 */
const OUTPUT_ONLY_COMMANDS = new Set(['echo', 'printf']);

const READ_ONLY_COMMANDS = new Set([
  'cat',
  'ls',
  'pwd',
  'grep',
  'egrep',
  'fgrep',
  'uniq',
  'head',
  'tail',
  'wc',
  'cut',
  'tr',
  'diff',
  'comm',
  'basename',
  'dirname',
  'realpath',
  'date',
  'sleep',
  'true',
  'false',
  'test',
  '[',
  'seq',
  'stat',
  'file',
  'du',
  'df',
  'whoami',
  'id',
  'hostname',
  'uname',
]);

/**
 * Tools whose file paths the extractor parses from their arguments. `sed` is
 * deliberately absent: `sed -e 'w out.txt'` writes through a script command
 * the extractor does not analyze.
 */
const PATH_ARGUMENT_COMMANDS = new Set(['rm', 'mv', 'cp', 'chmod']);

function firstCommandWord(cmd: string): string | null {
  const match = /^\s*([^\s;|&<>`$'"]+)/.exec(cmd);
  if (match === null) return null;
  return match[1] ?? null;
}

/** Option forms that relocate a path-argument command's write target. */
const UNSUPPORTED_PATH_COMMAND_OPTION = /(?:^|\s)(?:--target-directory(?:=|\s)|-t\s)/;

function isSemanticallyCoveredCommand(cmd: string): boolean {
  const word = firstCommandWord(cmd);
  if (word === null) return false;
  if (OUTPUT_ONLY_COMMANDS.has(word) || READ_ONLY_COMMANDS.has(word)) return true;
  if (!PATH_ARGUMENT_COMMANDS.has(word)) return false;
  // `cp/mv --target-directory=...` writes into a target the argument scan
  // deliberately skips; such commands stay unknown instead of docs-only.
  return !UNSUPPORTED_PATH_COMMAND_OPTION.test(cmd);
}

interface ShellScanState {
  quote: '"' | "'" | null;
  composed: boolean;
  skip: number;
}

function isFdDuplication(cmd: string, index: number): boolean {
  const previous = cmd[index - 1];
  return previous === '>' || previous === '<';
}

function isNonProvablePipe(cmd: string, index: number): boolean {
  const match = /^tee\s*([^\n;&|>]*)/.exec(cmd.slice(index + 1).trimStart());
  if (match === null) return true;
  // Only the append flag is understood; any other tee option is unprovable.
  return splitUnquotedArgs((match[1] ?? '').trim()).some(
    (operand) => operand.startsWith('-') && operand !== '-a' && operand !== '--append',
  );
}

function consumeDoubleQuoted(cmd: string, index: number, state: ShellScanState): void {
  const ch = cmd[index] ?? '';
  if (ch === '\\') {
    state.skip = 1;
    return;
  }
  if (ch === '$' || ch === '`') {
    state.composed = true;
    return;
  }
  if (ch === '"') state.quote = null;
}

function consumeSingleQuoted(cmd: string, index: number, state: ShellScanState): void {
  if ((cmd[index] ?? '') === "'") state.quote = null;
}

function consumeUnquoted(cmd: string, index: number, state: ShellScanState): void {
  const ch = cmd[index] ?? '';
  if (ch === '\\') {
    state.skip = 1;
    return;
  }
  if (ch === '"' || ch === "'") {
    state.quote = ch;
    return;
  }
  if (UNPROVEN_UNQUOTED.has(ch)) {
    state.composed = true;
    return;
  }
  if (ch === '&' && !isFdDuplication(cmd, index)) {
    state.composed = true;
    return;
  }
  if (ch === '|' && isNonProvablePipe(cmd, index)) {
    state.composed = true;
  }
}

/**
 * `*** <header>` lines an apply_patch document may carry. Any other `***`
 * header is an unanalyzed patch form and makes the target set unknown.
 */
const KNOWN_PATCH_HEADERS = [
  /^\*\*\* Begin Patch$/,
  /^\*\*\* End Patch$/,
  /^\*\*\* Update File: .+$/,
  /^\*\*\* Add File: .+$/,
  /^\*\*\* Delete File: .+$/,
  /^\*\*\* Move to: .+$/,
] as const;

/**
 * Whether every `***` header of an apply_patch document is a known form whose
 * paths the extractor captures. An unrecognized header keeps the scope
 * unknown so the provisional class is floored at STANDARD.
 */
export function isPatchScopeProvablyKnown(diff: string): boolean {
  if (diff.length > 1024 * 1024) return false;
  const headers = diff.match(/^\*\*\*[ \t]+[^\n\r]+$/gm) ?? [];
  return headers.every((header) => KNOWN_PATCH_HEADERS.some((pattern) => pattern.test(header)));
}

/**
 * Whether a bash command is provably covered by the extractor.
 *
 * A path extracted from one part of a compound command does not make the whole
 * command's target set known: `echo x > docs/a.md; python -c '...'` would
 * otherwise look TRIVIAL while unanalyzed writes remain. Known scope therefore
 * requires (a) a single simple pipeline — no unquoted `;`, `&&`, `&`, newline,
 * input redirection, substitution, or pipe other than to `tee` — and (b) a
 * command whose file writes are exhaustively captured by the extractor.
 * Interpreters, package managers, build tools and unknown executables stay
 * unknown and are floored at STANDARD, even when a redirect is visible.
 */
export function isBashScopeProvablyKnown(cmd: string): boolean {
  if (cmd.length > 1024 * 1024) return false;
  if (!isSemanticallyCoveredCommand(cmd)) return false;
  const state: ShellScanState = { quote: null, composed: false, skip: 0 };
  for (let index = 0; index < cmd.length && !state.composed; index += 1 + state.skip) {
    state.skip = 0;
    if (state.quote === '"') consumeDoubleQuoted(cmd, index, state);
    else if (state.quote === "'") consumeSingleQuoted(cmd, index, state);
    else consumeUnquoted(cmd, index, state);
  }
  return !state.composed && state.quote === null;
}

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

/** Unquoted characters that make the command's target set unprovable. */
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

  // 2. tee targets: | tee [-a] <file>
  const teePattern = /\|\s*tee\s+(?:-a\s+)?["']?([^\s"'|;&><]+)["']?/g;
  while ((match = teePattern.exec(cmd)) !== null) {
    const target = match[1] ?? '';
    if (target) paths.add(target);
  }

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

const UNPROVEN_UNQUOTED = new Set(['`', '$', '<', ';', '\n']);

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
  return !/^tee(?:\s|$)/.test(cmd.slice(index + 1).trimStart());
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
 * Whether a bash command is provably covered by the extractor.
 *
 * A path extracted from one part of a compound command does not make the whole
 * command's target set known: `echo x > docs/a.md; python -c '...'` would
 * otherwise look TRIVIAL while unanalyzed writes remain. Known scope therefore
 * requires the command to be a single simple pipeline: no unquoted `;`, `&&`,
 * `&`, newline, input redirection, substitution, or pipe other than to `tee`.
 * Anything else stays unknown and is floored at STANDARD (never TRIVIAL).
 */
export function isBashScopeProvablyKnown(cmd: string): boolean {
  if (cmd.length > 1024 * 1024) return false;
  const state: ShellScanState = { quote: null, composed: false, skip: 0 };
  for (let index = 0; index < cmd.length && !state.composed; index += 1 + state.skip) {
    state.skip = 0;
    if (state.quote === '"') consumeDoubleQuoted(cmd, index, state);
    else if (state.quote === "'") consumeSingleQuoted(cmd, index, state);
    else consumeUnquoted(cmd, index, state);
  }
  return !state.composed && state.quote === null;
}

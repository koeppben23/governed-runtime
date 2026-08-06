import type { Assertion, AssertionResult } from './schema.js';

export interface WorkspaceEntry {
  sha256: string;
  bytes: number;
}

export type WorkspaceSnapshot = Map<string, WorkspaceEntry>;

export interface AssertionContext {
  stdout: string;
  stderr: string;
  exitCode: number;
  beforeSnapshot: WorkspaceSnapshot;
  afterSnapshot: WorkspaceSnapshot;
  beforeContent: Map<string, string>;
  afterContent: Map<string, string>;
}

function combinedStream(stdout: string, stderr: string): string {
  return stdout + '\n' + stderr;
}

function resolveStream(
  stream: string,
  stdout: string,
  stderr: string,
): string {
  if (stream === 'stdout') return stdout;
  if (stream === 'stderr') return stderr;
  return combinedStream(stdout, stderr);
}

export function evaluateAssertion(
  assertion: Assertion,
  ctx: AssertionContext,
): AssertionResult {
  const base = {
    description: assertion.description,
    type: assertion.type,
    severity: assertion.severity,
    expected: '',
    received: '',
  };

  switch (assertion.type) {
    // ── Output assertions ──────────────────────────────────────────
    case 'output_contains': {
      const haystack = resolveStream(assertion.stream, ctx.stdout, ctx.stderr);
      return { ...base, passed: haystack.includes(assertion.value), expected: assertion.value };
    }
    case 'output_matches': {
      const haystack = resolveStream(assertion.stream, ctx.stdout, ctx.stderr);
      const re = new RegExp(assertion.pattern, assertion.flags ?? '');
      return { ...base, passed: re.test(haystack), expected: `/${assertion.pattern}/${assertion.flags ?? ''}` };
    }
    case 'output_not_contains': {
      const haystack = resolveStream(assertion.stream, ctx.stdout, ctx.stderr);
      return { ...base, passed: !haystack.includes(assertion.value), expected: `NOT "${assertion.value}"` };
    }
    case 'output_not_matches': {
      const haystack = resolveStream(assertion.stream, ctx.stdout, ctx.stderr);
      const re = new RegExp(assertion.pattern, assertion.flags ?? '');
      return { ...base, passed: !re.test(haystack), expected: `NOT /${assertion.pattern}/${assertion.flags ?? ''}` };
    }
    case 'exit_code': {
      return {
        ...base,
        passed: ctx.exitCode === assertion.value,
        expected: String(assertion.value),
        received: String(ctx.exitCode),
      };
    }
    // ── File assertions ────────────────────────────────────────────
    case 'file_exists': {
      const exists = ctx.afterSnapshot.has(assertion.path);
      return { ...base, passed: exists, expected: assertion.path };
    }
    case 'file_changed': {
      const before = ctx.beforeSnapshot.get(assertion.path);
      const after = ctx.afterSnapshot.get(assertion.path);
      const changed =
        !before || !after
          ? before !== after
          : before.sha256 !== after.sha256;
      return { ...base, passed: changed, expected: `${assertion.path} changed` };
    }
    case 'file_not_changed': {
      const before = ctx.beforeSnapshot.get(assertion.path);
      const after = ctx.afterSnapshot.get(assertion.path);
      const unchanged =
        before && after ? before.sha256 === after.sha256 : before === after;
      return { ...base, passed: unchanged, expected: `${assertion.path} unchanged` };
    }
    case 'file_contains': {
      const content = ctx.afterContent.get(assertion.path);
      if (content === undefined) {
        return { ...base, passed: false, expected: assertion.value, received: 'file not found in after snapshot' };
      }
      return { ...base, passed: content.includes(assertion.value), expected: assertion.value };
    }
    case 'file_not_contains': {
      const content = ctx.afterContent.get(assertion.path);
      if (content === undefined) {
        return { ...base, passed: true, expected: `NOT "${assertion.value}"` };
      }
      return { ...base, passed: !content.includes(assertion.value), expected: `NOT "${assertion.value}"` };
    }
    default:
      return { ...base, passed: false, expected: 'unknown assertion type' };
  }
}

export function evaluateAllAssertions(
  assertions: Assertion[],
  ctx: AssertionContext,
): AssertionResult[] {
  return assertions.map((a) => evaluateAssertion(a, ctx));
}

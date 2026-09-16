/**
 * @module architecture/structured-review-authority-guard
 * @description Architecture guard: independent review is authorized exclusively
 * by a host-observed structured child-session invocation. The reviewer Task and
 * manual/native attestation authority, agent-submitted findings inputs, and
 * legacy invocation modes must not reappear in production code.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

function listProductionSources(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...listProductionSources(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      results.push(full);
    }
  }
  return results;
}

function relative(path: string): string {
  return path
    .slice(SRC.length + 1)
    .split(sep)
    .join('/');
}

describe('structured review authority hard cut', () => {
  it('retires the reviewer Task and manual/native attestation authority', () => {
    const retirements =
      /\b(manual_attested|native_subagent_attested|recordSubmittedReviewInvocation|resolveNativeAttestation|reviewInvocationPolicy|host_task_required|host_task_preferred|reviewerTaskPrompt)\b/;
    const offenders = listProductionSources(SRC).filter((file) =>
      retirements.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map(relative)).toEqual([]);
  });

  it('removes the peer review invocation recorder', () => {
    expect(existsSync(join(SRC, 'integration/tools/review-tool/invocation.ts'))).toBe(false);
  });

  it('accepts no reviewer findings from tool arguments', () => {
    const reviewToolTypes = readFileSync(
      join(SRC, 'integration/tools/review-tool/types.ts'),
      'utf8',
    );
    expect(reviewToolTypes).not.toContain('reviewFindings?:');
    const classifier = readFileSync(
      join(SRC, 'integration/tools/review-validation-mode.ts'),
      'utf8',
    );
    expect(classifier).not.toContain('reviewFindings');
  });

  it('persists the durable dispatch before release on every production path', () => {
    const adapter = readFileSync(join(SRC, 'integration/opencode-host-adapter.ts'), 'utf8');
    expect(adapter).toContain('_authorizeDispatch: config.authorizeDispatch');
    expect(adapter).toContain('_abandonDispatch: config.abandonDispatch');
    for (const pipeline of [
      'integration/review/standard-review-pipeline.ts',
      'integration/review/content-review-pipeline.ts',
    ]) {
      const content = readFileSync(join(SRC, pipeline), 'utf8');
      expect(content, `${pipeline} must authorize the dispatch`).toContain('authorizeDispatch:');
      expect(content, `${pipeline} must abandon concluded host calls`).toContain(
        'abandonDispatch:',
      );
      expect(content, `${pipeline} must persist the durable ledger entry`).toContain(
        'persistAuthorizedSdkDispatch',
      );
    }
  });

  it('invokes the transport only through the host adapter', () => {
    const callers = listProductionSources(SRC).filter((file) =>
      /(?<!function )\binvokeReviewer\s*\(/.test(readFileSync(file, 'utf8')),
    );
    expect(callers.map(relative)).toEqual(['integration/opencode-host-adapter.ts']);
  });

  it('admits exactly the host-observed structured invocation generation', () => {
    const schema = readFileSync(join(SRC, 'state/evidence-review-invocation.ts'), 'utf8');
    expect(schema).toContain("invocationMode: z.literal('sdk_session_prompt')");
    expect(schema).toContain("source: z.literal('host-orchestrated')");
    expect(schema).toContain("reviewOutputMode: z.literal('structured_output')");
    expect(schema).toContain('structuredOutputUsed: z.literal(true)');
    expect(schema).toContain("reviewAssuranceLevel: z.literal('structured_high')");
    expect(schema).toContain('capturedRawFindings: z.record');
    expect(schema).not.toContain('z.enum');
  });
});

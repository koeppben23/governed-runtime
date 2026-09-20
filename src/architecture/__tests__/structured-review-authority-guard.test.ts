/**
 * @module architecture/structured-review-authority-guard
 * @description Architecture guard: independent review is authorized exclusively
 * by a host-observed structured child-session invocation. The reviewer Task and
 * manual/native attestation authority, agent-submitted findings inputs, and
 * legacy invocation modes must not reappear in production code.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isTestSourcePath } from './module-classification.js';
import { repoRelative } from './repo-path.js';

const SRC = join(process.cwd(), 'src');

function listProductionSources(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...listProductionSources(full));
    } else if (entry.endsWith('.ts')) {
      if (isTestSourcePath(repoRelative(SRC, full))) continue;
      results.push(full);
    }
  }
  return results;
}

function relative(path: string): string {
  return repoRelative(SRC, path);
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

  it('persists the durable dispatch before host release on the native path', () => {
    const native = readFileSync(join(SRC, 'integration/review/native-task-review.ts'), 'utf8');
    const persistIndex = native.indexOf('persistAuthorizedReviewDispatch(');
    const releaseIndex = native.indexOf('mutateNativeTask(hookOutput');
    expect(persistIndex, 'the dispatch must be persisted').toBeGreaterThan(-1);
    expect(releaseIndex, 'the Task args must be overwritten before release').toBeGreaterThan(-1);
    expect(persistIndex, 'no host release without a durable dispatch').toBeLessThan(releaseIndex);
    expect(native).toContain('abandonReviewDispatchByHostCall');
  });

  it('never autospawns an invisible SDK reviewer and exposes no spawn capability', () => {
    const adapter = readFileSync(join(SRC, 'integration/opencode-host-adapter.ts'), 'utf8');
    const hostAdapter = readFileSync(join(SRC, 'adapters/host-adapter.ts'), 'utf8');
    // No HostAdapter member may claim a reviewer-spawn capability: the native
    // Task is dispatched by the parent agent and governed at the hook boundary.
    expect(adapter).not.toContain('spawnReviewer');
    expect(hostAdapter).not.toContain('spawnReviewer');
    // The SDK child-session transport must not exist as an importable
    // authority surface anywhere in production, not merely stay unused.
    const sources = listProductionSources(SRC).map((file) => ({
      file,
      content: readFileSync(file, 'utf8'),
    }));
    const offenders = (pattern: RegExp) =>
      sources.filter(({ content }) => pattern.test(content)).map(({ file }) => relative(file));
    expect(offenders(/\binvokeReviewer\b/)).toEqual([]);
    expect(offenders(/session\.create\s*\(/)).toEqual([]);
    expect(offenders(/\b(?:persistAuthorizedSdkDispatch|abandonSdkDispatch)\b/)).toEqual([]);
  });

  it('projects review dispatch requirements only from the authority-bound instruction builder', () => {
    // `reviewDispatchRequired()` may only be referenced by the dispatch-signal
    // definition and the authority-bound child-session instruction. Producers
    // must go through the instruction, which requires a full
    // ReviewDispatchAuthority.
    const allowed = new Set([
      'integration/review/dispatch-signal.ts',
      'integration/review/child-session-instruction.ts',
    ]);
    const offenders = listProductionSources(SRC)
      .filter((file) => /\breviewDispatchRequired\b/.test(readFileSync(file, 'utf8')))
      .map(relative)
      .filter((rel) => !allowed.has(rel));
    expect(offenders).toEqual([]);
  });

  it('admits exactly the native visible structured invocation generation', () => {
    const schema = readFileSync(join(SRC, 'state/evidence-review-invocation.ts'), 'utf8');
    expect(schema).toContain("invocationMode: z.literal('native_task_structured_followup')");
    expect(schema).toContain('hostVisible: z.literal(true)');
    expect(schema).toContain('transcriptNavigable: z.literal(true)');
    expect(schema).toContain("source: z.literal('host-orchestrated')");
    expect(schema).toContain("reviewOutputMode: z.literal('structured_output')");
    expect(schema).toContain('structuredOutputUsed: z.literal(true)');
    expect(schema).toContain("reviewAssuranceLevel: z.literal('structured_high')");
    expect(schema).toContain('capturedRawFindings: z.record');
    expect(schema).not.toContain('z.enum');
  });
});

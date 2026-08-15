/**
 * @module rails/repository-authority-freeze-union.test
 * @description Real-repository coverage for the typed plan/architecture freeze
 *              degradation (`RepositoryAuthorityFreezeResult`): distinct,
 *              auditable reasons instead of a silent `undefined` collapse.
 *
 * @test-policy HAPPY, BAD, CORNER
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  freezeContextAuthority,
  freezeContextAuthorityAtHead,
  frozenAuthorityOrUndefined,
} from './repository-authority.js';

let repo: string;
let emptyRepo: string;
let plainDir: string;

beforeAll(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-freeze-union-'));
  repo = path.join(base, 'repo');
  emptyRepo = path.join(base, 'empty-repo');
  plainDir = path.join(base, 'plain');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(emptyRepo, { recursive: true });
  fs.mkdirSync(plainDir, { recursive: true });

  const git = (cwd: string, a: string[]) =>
    execFileSync('git', a, { cwd, encoding: 'utf-8' }).trim();
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 't@example.com']);
  git(repo, ['config', 'user.name', 'T']);
  fs.writeFileSync(path.join(repo, 'file.txt'), 'content\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'base']);

  git(emptyRepo, ['init', '-q']);
});

afterAll(() => {
  fs.rmSync(path.dirname(repo), { recursive: true, force: true });
});

describe('freezeContextAuthorityAtHead — typed degradation', () => {
  it('HAPPY: real repository with a commit → available context authority', async () => {
    const result = await freezeContextAuthorityAtHead(repo);
    expect(result.kind).toBe('available');
    if (result.kind === 'available' && result.authority.kind === 'context') {
      expect(result.authority.context.kind).toBe('commit');
      const identity = result.authority.context.repositoryIdentity;
      if ('kind' in identity) expect(identity.kind).toBe('local');
      expect(result.authority.context.objectSha).toMatch(/^[0-9a-f]{40}$/);
    }
    expect(frozenAuthorityOrUndefined(result)?.kind).toBe('context');
  });

  it('BAD: not a Git repository → repository_unavailable', async () => {
    const result = await freezeContextAuthorityAtHead(plainDir);
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') {
      expect(result.reason).toBe('repository_unavailable');
      expect(result.diagnostic).toBeTruthy();
    }
    expect(frozenAuthorityOrUndefined(result)).toBeUndefined();
  });

  it('BAD: repository without HEAD commit → head_unavailable', async () => {
    const result = await freezeContextAuthorityAtHead(emptyRepo);
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') {
      expect(result.reason).toBe('head_unavailable');
      expect(result.diagnostic).toBeTruthy();
    }
  });
});

describe('freezeContextAuthority — typed identity degradation', () => {
  it('HAPPY: resolvable identity → available', () => {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
    const result = freezeContextAuthority(repo, sha);
    expect(result.kind).toBe('available');
    if (result.kind === 'available' && result.authority.kind === 'context') {
      expect(result.authority.context.objectSha).toBe(sha);
    }
  });

  it('BAD: unresolvable identity → repository_identity_unavailable with diagnostic', () => {
    const result = freezeContextAuthority(repo, '0'.repeat(40));
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') {
      expect(result.reason).toBe('repository_identity_unavailable');
      expect(result.diagnostic).toBeTruthy();
    }
  });
});

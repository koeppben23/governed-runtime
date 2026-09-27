/**
 * @module integration/tools/ticket-content-adoption.test
 * @description Real-worktree contract for canonical ticket content adoption:
 * `ticketSource` reads and digest-binds repository file content, and the
 * reference backstop prevents a bare file/URL reference from being stored as
 * the ticket — independently of whether the referenced path exists.
 *
 * @test-policy HAPPY, BAD
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readState } from '../../adapters/persistence.js';
import { hashText } from '../../shared/hashing.js';
import { sessionDir } from '../../adapters/workspace/index.js';
import { computeFingerprint } from '../../adapters/workspace/fingerprint.js';
import { hydrate } from '../tools/hydrate/hydrate.js';
import { ticket } from '../tools/simple/ticket-tool.js';
import type { ToolContext } from '../tools/helpers.js';

const TICKET_FILE = 'TICKET_DOCS.md';
const TICKET_CONTENT = [
  '# TICKET: Document Local Build and Test Instructions',
  '',
  'Risk: TRIVIAL',
  '',
  'Create `docs/usage-notes.md` with a short local usage guide.',
  '',
].join('\n');

interface SE {
  rootDir: string;
  worktree: string;
  configDir: string;
  sId: string;
  sDir: string;
  tc: ToolContext;
}

let s: SE | undefined;
let pc: string | undefined;

beforeEach(() => {
  pc = process.env.OPENCODE_CONFIG_DIR;
});

afterEach(() => {
  if (pc === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = pc;
  if (s) {
    rmSync(s.rootDir, { recursive: true, force: true });
    s = undefined;
  }
});

async function boot(): Promise<SE> {
  const r = mkdtempSync(join(tmpdir(), 'fg-ticket-adoption-'));
  const w = join(r, 'worktree');
  const c = join(r, 'config');
  const id = randomUUID();
  mkdirSync(w, { recursive: true });
  mkdirSync(c, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: w });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: w });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: w });
  writeFileSync(join(w, 'README.md'), '# E2E');
  execFileSync('git', ['add', 'README.md'], { cwd: w });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: w });
  process.env.OPENCODE_CONFIG_DIR = c;
  const tc: ToolContext = {
    sessionID: id,
    messageID: randomUUID(),
    agent: 'test',
    directory: w,
    worktree: w,
    abort: new AbortController().signal,
    metadata: () => {},
  };
  const hydrated = await hydrate.execute({ policyMode: 'solo', profileId: 'baseline' }, tc);
  if (typeof hydrated !== 'string' || hydrated.includes('"error":true')) {
    throw new Error(`boot hydrate failed: ${String(hydrated).slice(0, 400)}`);
  }
  const fp = await computeFingerprint(w);
  return {
    rootDir: r,
    worktree: w,
    configDir: c,
    sId: id,
    sDir: sessionDir(fp.fingerprint, id),
    tc,
  };
}

describe('ticket content adoption (real worktree)', () => {
  it('HAPPY: ticketSource reads the file, binds its digest and parses the declaration', async () => {
    s = await boot();
    const se = s;
    writeFileSync(join(se.worktree, TICKET_FILE), TICKET_CONTENT);

    const result = await ticket.execute(
      { ticketSource: { kind: 'repository_file', path: TICKET_FILE }, source: 'user' },
      se.tc,
    );
    expect(String(result)).not.toContain('"error":true');

    const state = await readState(se.sDir);
    expect(state!.ticket?.text).toBe(TICKET_CONTENT);
    expect(state!.ticket?.digest).toBe(hashText(TICKET_CONTENT));
    expect(state!.ticket?.inputOrigin).toBe('workspace');
    expect(state!.ticket?.riskDeclaration).toEqual({ kind: 'declared', taskClass: 'TRIVIAL' });
    expect(state!.ticket?.references?.map((reference) => reference.ref)).toContain(TICKET_FILE);
  });

  it('BAD: a missing ticketSource file fails closed', async () => {
    s = await boot();
    const se = s;

    const result = await ticket.execute(
      { ticketSource: { kind: 'repository_file', path: 'TICKET_DOCS.md' }, source: 'user' },
      se.tc,
    );
    expect(String(result)).toContain('TICKET_SOURCE_UNREADABLE');
    expect((await readState(se.sDir))!.ticket).toBeNull();
  });

  it('BAD: ticketSource and text together are rejected as a source conflict', async () => {
    s = await boot();
    const se = s;
    writeFileSync(join(se.worktree, TICKET_FILE), TICKET_CONTENT);

    const result = await ticket.execute(
      {
        text: 'Some prose that competes with the file content',
        ticketSource: { kind: 'repository_file', path: TICKET_FILE },
        source: 'user',
      },
      se.tc,
    );
    expect(String(result)).toContain('TICKET_SOURCE_CONFLICT');
    expect((await readState(se.sDir))!.ticket).toBeNull();
  });

  it('BAD: a bare file reference never becomes the ticket content', async () => {
    s = await boot();
    const se = s;
    writeFileSync(join(se.worktree, TICKET_FILE), TICKET_CONTENT);

    const result = await ticket.execute({ text: TICKET_FILE, source: 'user' }, se.tc);
    expect(String(result)).toContain('TICKET_REFERENCE_WITHOUT_CONTENT');
    expect((await readState(se.sDir))!.ticket).toBeNull();
  });

  it('BAD: a read instruction on a MISSING path still blocks (typo cannot bypass adoption)', async () => {
    s = await boot();
    const se = s;

    const result = await ticket.execute(
      { text: 'Read TICKET_DOCS_MISSING.md and create the requested usage notes', source: 'user' },
      se.tc,
    );
    expect(String(result)).toContain('TICKET_REFERENCE_WITHOUT_CONTENT');
    expect((await readState(se.sDir))!.ticket).toBeNull();
  });

  it('HAPPY: prose that merely mentions an existing filename stays a regular ticket', async () => {
    s = await boot();
    const se = s;

    const result = await ticket.execute(
      { text: 'Fix the typo in the README.md installation section', source: 'user' },
      se.tc,
    );
    expect(String(result)).not.toContain('"error":true');
    const state = await readState(se.sDir);
    expect(state!.ticket?.text).toBe('Fix the typo in the README.md installation section');
    expect(state!.ticket?.riskDeclaration).toEqual({ kind: 'absent' });
  });

  it('BAD: an in-worktree symlink pointing outside the worktree fails closed', async () => {
    s = await boot();
    const se = s;
    const outside = resolve(se.worktree, '..', 'private-notes.md');
    writeFileSync(outside, '# outside secret\n\nRisk: TRIVIAL');
    symlinkSync(outside, join(se.worktree, 'TICKET_LINK.md'));

    const result = await ticket.execute(
      { ticketSource: { kind: 'repository_file', path: 'TICKET_LINK.md' }, source: 'user' },
      se.tc,
    );
    expect(String(result)).toContain('TICKET_SOURCE_UNREADABLE');
    expect((await readState(se.sDir))!.ticket).toBeNull();
  });

  it('BAD: a broken symlink fails closed instead of falling back to the link target string', async () => {
    s = await boot();
    const se = s;
    symlinkSync(join(se.worktree, 'does-not-exist.md'), join(se.worktree, 'TICKET_LINK.md'));

    const result = await ticket.execute(
      { ticketSource: { kind: 'repository_file', path: 'TICKET_LINK.md' }, source: 'user' },
      se.tc,
    );
    expect(String(result)).toContain('TICKET_SOURCE_UNREADABLE');
    expect((await readState(se.sDir))!.ticket).toBeNull();
  });

  it('HAPPY: an in-worktree symlink to an in-worktree file is adopted', async () => {
    s = await boot();
    const se = s;
    writeFileSync(join(se.worktree, 'REAL_TICKET.md'), TICKET_CONTENT);
    symlinkSync(join(se.worktree, 'REAL_TICKET.md'), join(se.worktree, 'TICKET_LINK.md'));

    const result = await ticket.execute(
      { ticketSource: { kind: 'repository_file', path: 'TICKET_LINK.md' }, source: 'user' },
      se.tc,
    );
    expect(String(result)).not.toContain('"error":true');
    const state = await readState(se.sDir);
    expect(state!.ticket?.text).toBe(TICKET_CONTENT);
  });

  it('BAD: a ticketSource path escaping the worktree fails closed', async () => {
    s = await boot();
    const se = s;
    const outside = resolve(se.worktree, '..', 'outside.md');
    writeFileSync(outside, '# outside');

    const result = await ticket.execute(
      { ticketSource: { kind: 'repository_file', path: '../outside.md' }, source: 'user' },
      se.tc,
    );
    expect(String(result)).toContain('TICKET_SOURCE_UNREADABLE');
    expect((await readState(se.sDir))!.ticket).toBeNull();
  });
});

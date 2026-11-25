/** Installed OpenCode copy must not invent activation or authority recovery. */
import { describe, expect, it } from 'vitest';
import { COMMANDS } from './index.js';

describe('installed command activation contract', () => {
  it.each(['ticket.md', 'plan.md', 'architecture.md', 'finish.md', 'status.md'])(
    '%s stops for inactive or missing authority without auto-hydration',
    (file) => {
      const body = COMMANDS[file];
      expect(body).toContain('explicit `/start`');
      expect(body).toMatch(/stop/i);
      expect(body).toMatch(/authority.*missing|authority is missing/i);
      expect(body).not.toContain('call `flowguard_hydrate` first');
    },
  );

  it('retains hydrate as reload, never external activation or missing-authority recreation', () => {
    const body = COMMANDS['hydrate.md'];
    expect(body).toContain('Otherwise call `flowguard_hydrate` with no arguments');
    expect(body).toContain('Do not activate governance automatically');
    expect(body).toContain('neither hydrate nor a repeated start may recreate that authority');
    expect(body).toContain('terminal session hydrate is a read-only reload, not a restart');
    expect(body).not.toContain('Run this FIRST');
    expect(body).not.toContain('Hydrate creates a session');
  });

  it.each(['abort.md', 'implement.md'])(
    '%s requires a distinct host session for new work, not restarting an ACTIVE binding',
    (file) => {
      const body = COMMANDS[file];
      expect(body).toMatch(/distinct host session/);
      expect(body).toContain('/start');
      expect(body).toMatch(/pre-change worktree/);
      expect(body).toMatch(/ACTIVE binding/);
      expect(body).not.toMatch(/fresh `\/hydrate`|\/hydrate can start a new session/);
    },
  );
});

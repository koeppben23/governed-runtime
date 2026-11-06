/** Native child executor isolation. These structural mocks do not certify host provenance. */
import { describe, expect, it, vi } from 'vitest';
import { executeCanonicalNativeTool } from './plugin-native-tools.js';
import {
  FLOWGUARD_TOOL_NAMES,
  TOOL_FLOWGUARD_HELP,
  TOOL_FLOWGUARD_OBSERVE_REPOSITORY,
} from './tool-names.js';

function fixture(agent = 'flowguard-reviewer') {
  const execute = vi.fn(async () => 'observed');
  const definition = { args: {}, description: 'structural test tool', execute };
  const resolveSessionAuthority = vi.fn(async () => ({
    status: 'resolved',
    worktreeRoot: '/canonical',
  }));
  const entry = {
    runtime: { ws: { resolveSessionAuthority } },
    scope: { sessionId: 'child', root: { sessionId: 'parent' } },
  };
  const context = {
    sessionID: 'child',
    messageID: 'msg_observe',
    agent,
    signal: new AbortController().signal,
  };
  return { execute, definition, resolveSessionAuthority, entry, context };
}

describe('native reviewer observation executor', () => {
  it('resolves parent workspace authority but preserves the actual executing child identity', async () => {
    const h = fixture();
    await expect(
      executeCanonicalNativeTool(
        TOOL_FLOWGUARD_OBSERVE_REPOSITORY,
        h.definition,
        {},
        h.context as never,
        h.entry as never,
      ),
    ).resolves.toEqual({ content: 'observed', metadata: {} });
    expect(h.resolveSessionAuthority).toHaveBeenCalledWith('parent');
    expect(h.execute).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        sessionID: 'child',
        agent: 'flowguard-reviewer',
        worktree: '/canonical',
        directory: '/canonical',
      }),
    );
  });

  it.each(
    FLOWGUARD_TOOL_NAMES.filter(
      (name) => name !== TOOL_FLOWGUARD_HELP && name !== TOOL_FLOWGUARD_OBSERVE_REPOSITORY,
    ),
  )('refuses delegated %s before canonical execution', async (name) => {
    const h = fixture();
    await expect(
      executeCanonicalNativeTool(name, h.definition, {}, h.context as never, h.entry as never),
    ).rejects.toHaveProperty('code', 'GOVERNANCE_AUTHORITY_BLOCKED');
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.resolveSessionAuthority).not.toHaveBeenCalled();
  });

  it('does not authorize repository observations for an ordinary delegated agent', async () => {
    const h = fixture('build');
    await expect(
      executeCanonicalNativeTool(
        TOOL_FLOWGUARD_OBSERVE_REPOSITORY,
        h.definition,
        {},
        h.context as never,
        h.entry as never,
      ),
    ).rejects.toHaveProperty('code', 'GOVERNANCE_AUTHORITY_BLOCKED');
    expect(h.execute).not.toHaveBeenCalled();
  });
});

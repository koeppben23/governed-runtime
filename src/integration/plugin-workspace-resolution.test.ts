import { describe, expect, it, vi } from 'vitest';

const { computeFingerprint, resolveCanonicalAuthority } = vi.hoisted(() => ({
  computeFingerprint: vi.fn(),
  resolveCanonicalAuthority: vi.fn(),
}));

vi.mock('../adapters/workspace/index.js', () => ({
  computeFingerprint,
  workspaceDir: (fingerprint: string) => `/workspace/${fingerprint}`,
  sessionDir: (fingerprint: string, sessionId: string) => `/workspace/${fingerprint}/${sessionId}`,
}));

vi.mock('../adapters/session-authority.js', () => ({
  resolveSessionAuthority: resolveCanonicalAuthority,
}));

import { PluginWorkspaceImpl } from './plugin-workspace.js';

describe('PluginWorkspaceImpl workspace resolution', () => {
  it('caches one resolved fingerprint for boot metadata and delegates session authority canonically', async () => {
    computeFingerprint.mockResolvedValue({ fingerprint: 'workspace-fingerprint' });
    resolveCanonicalAuthority.mockResolvedValue({
      status: 'absent',
      sessDir: '/workspace/workspace-fingerprint/host-session',
      worktreeRoot: '/repo',
      fingerprint: 'workspace-fingerprint',
    });
    const workspace = new PluginWorkspaceImpl({ auditWorktree: '/repo' });

    expect(await workspace.resolveFingerprint()).toBe('workspace-fingerprint');
    expect(await workspace.resolveFingerprint()).toBe('workspace-fingerprint');
    expect(computeFingerprint).toHaveBeenCalledTimes(1);
    expect(workspace.cachedWsDir).toBe('/workspace/workspace-fingerprint');
    // Session directories are never derived from the cached fingerprint: the
    // canonical adapter is the only entrypoint.
    await expect(workspace.resolveSessionAuthority('host-session')).resolves.toMatchObject({
      status: 'absent',
      sessDir: '/workspace/workspace-fingerprint/host-session',
    });
    expect(resolveCanonicalAuthority).toHaveBeenCalledWith({
      root: '/repo',
      sessionId: 'host-session',
    });
  });
});

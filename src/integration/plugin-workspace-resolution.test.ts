import { describe, expect, it, vi } from 'vitest';

const { computeFingerprint } = vi.hoisted(() => ({ computeFingerprint: vi.fn() }));

vi.mock('../adapters/workspace/index.js', () => ({
  computeFingerprint,
  workspaceDir: (fingerprint: string) => `/workspace/${fingerprint}`,
  sessionDir: (fingerprint: string, sessionId: string) => `/workspace/${fingerprint}/${sessionId}`,
}));

import { PluginWorkspaceImpl } from './plugin-workspace.js';

describe('PluginWorkspaceImpl workspace resolution', () => {
  it('caches one resolved fingerprint and derives the workspace and session directories from it', async () => {
    computeFingerprint.mockResolvedValue({ fingerprint: 'workspace-fingerprint' });
    const workspace = new PluginWorkspaceImpl({ auditWorktree: '/repo' });

    expect(await workspace.resolveFingerprint()).toBe('workspace-fingerprint');
    expect(await workspace.resolveFingerprint()).toBe('workspace-fingerprint');
    expect(computeFingerprint).toHaveBeenCalledTimes(1);
    expect(workspace.cachedWsDir).toBe('/workspace/workspace-fingerprint');
    expect(workspace.getSessionDir('host-session')).toBe(
      '/workspace/workspace-fingerprint/host-session',
    );
  });
});

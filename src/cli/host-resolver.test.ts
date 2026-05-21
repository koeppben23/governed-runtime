/**
 * @module cli/host-resolver.test
 * @description Tests for strict FlowGuard CLI host resolution.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_CONFIG } from '../config/flowguard-config.js';
import { PersistenceError } from '../adapters/persistence.js';
import { readConfig } from '../adapters/persistence-config.js';
import { resolveHost } from './host-resolver.js';

vi.mock('../adapters/persistence-config.js', () => ({
  readConfig: vi.fn(),
}));

describe('resolveHost', () => {
  beforeEach(() => {
    vi.mocked(readConfig).mockResolvedValue(DEFAULT_CONFIG);
  });

  it('uses CLI host before config', async () => {
    vi.mocked(readConfig).mockResolvedValue({
      ...DEFAULT_CONFIG,
      host: { defaultHost: 'codex' },
    });

    await expect(resolveHost({ cliHost: 'claude-code', cwd: '/repo' })).resolves.toEqual({
      host: 'claude-code',
      source: 'cli',
    });
    expect(readConfig).not.toHaveBeenCalled();
  });

  it('uses config host when CLI host is absent', async () => {
    vi.mocked(readConfig).mockResolvedValue({
      ...DEFAULT_CONFIG,
      host: { defaultHost: 'codex' },
    });

    await expect(resolveHost({ cwd: '/repo' })).resolves.toEqual({
      host: 'codex',
      source: 'config',
    });
  });

  it('defaults to opencode when CLI and config host are absent', async () => {
    await expect(resolveHost({ cwd: '/repo' })).resolves.toEqual({
      host: 'opencode',
      source: 'default',
    });
  });

  it('propagates invalid config errors without fallback', async () => {
    vi.mocked(readConfig).mockRejectedValue(
      new PersistenceError('SCHEMA_VALIDATION_FAILED', 'Repo config failed schema validation'),
    );

    await expect(resolveHost({ cwd: '/repo' })).rejects.toThrow('Repo config failed schema validation');
  });
});

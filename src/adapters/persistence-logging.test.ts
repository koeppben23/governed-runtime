import { describe, it, expect, vi, afterEach } from 'vitest';

const { mockError, mockWarn, mockAccess } = vi.hoisted(() => ({
  mockError: vi.fn(),
  mockWarn: vi.fn(),
  mockAccess: vi.fn(),
}));

vi.mock('../logging/adapter-logger.js', () => ({
  getAdapterLogger: () => ({
    error: mockError,
    warn: mockWarn,
    info: vi.fn(),
  }),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    access: (...args: unknown[]) => mockAccess(...args),
  };
});

import { stateExists } from './persistence.js';

describe('persistence logging', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('stateExists returns false silently for ENOENT', async () => {
    mockAccess.mockRejectedValueOnce(Object.assign(new Error('no such file'), { code: 'ENOENT' }));

    const result = await stateExists('/nonexistent/sess');
    expect(result).toBe(false);
    expect(mockWarn).not.toHaveBeenCalled();
    expect(mockError).not.toHaveBeenCalled();
  });

  it('stateExists returns false silently for ENOTDIR', async () => {
    mockAccess.mockRejectedValueOnce(
      Object.assign(new Error('not a directory'), { code: 'ENOTDIR' }),
    );

    const result = await stateExists('/tmp/file/sess');
    expect(result).toBe(false);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('stateExists logs non-ENOENT error and returns false', async () => {
    mockAccess.mockRejectedValueOnce(
      Object.assign(new Error('permission denied'), { code: 'EACCES' }),
    );

    const result = await stateExists('/protected/sess');
    expect(result).toBe(false);
    expect(mockWarn).toHaveBeenCalledWith(
      'persistence',
      'Failed to check state existence',
      expect.objectContaining({ code: 'EACCES' }),
    );
  });
});

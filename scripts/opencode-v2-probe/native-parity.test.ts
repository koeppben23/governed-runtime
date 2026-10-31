import { describe, expect, it } from 'vitest';
import { compareNativeParity, normalizeFixturePaths } from './lib/native-parity.mjs';

function cases() {
  const summary = {
    tools: [{ name: 'shell', input: { type: 'object' } }],
    model: 'probe',
    reasoningEffort: 'high',
    models: [{ id: 'probe', variants: ['chosen'] }],
    agents: [{ id: 'build', permissions: ['allow'] }],
    pluginActive: false,
    journalTypes: [],
  };
  const absent = {
    passed: true,
    cleaned: true,
    artifact: { sha256: 'pinned' },
    journal: [],
    summary,
  };
  const passive = {
    ...structuredClone(absent),
    summary: { ...structuredClone(summary), pluginActive: true, journalTypes: ['setup:ready'] },
  };
  return { absent, passive };
}

describe('bounded native-parity evidence assessment', () => {
  it('supports only successful, cleaned observations with all comparisons present', () => {
    const { absent, passive } = cases();
    expect(compareNativeParity(absent, passive).fixtureStatus).toBe('SUPPORTED');
    expect(compareNativeParity({}, {}).fixtureStatus).toBe('NOT_VERIFIED');
  });
  it.each([
    'tools',
    'models',
    'agents',
    'reasoningEffort',
    'model',
    'journalTypes',
    'pluginActive',
  ])('rejects missing or changed %s', (key) => {
    const { absent, passive } = cases();
    const changed: Record<string, unknown> = passive.summary;
    changed[key] = 'unexpected';
    expect(compareNativeParity(absent, passive).fixtureStatus).toBe('NOT_VERIFIED');
    delete changed[key];
    expect(compareNativeParity(absent, passive).fixtureStatus).toBe('NOT_VERIFIED');
  });
  it('cannot pass on admission alone, failed cleanup, or a different binary', () => {
    const { absent, passive } = cases();
    for (const patch of [
      { passed: false },
      { cleaned: false },
      { artifact: { sha256: 'other' } },
    ]) {
      expect(compareNativeParity(absent, { ...passive, ...patch }).fixtureStatus).toBe(
        'NOT_VERIFIED',
      );
    }
  });
  it('normalizes only the exact disposable root, retaining other paths and permissions', () => {
    expect(normalizeFixturePaths('/fixture-sibling/private', '/fixture')).toBe(
      '/fixture-sibling/private',
    );
    expect(
      normalizeFixturePaths(
        {
          rules: [
            { resource: '/fixture/.opencode/plan/*', effect: 'deny' },
            { resource: '/operator/private', effect: 'allow' },
          ],
        },
        '/fixture',
      ),
    ).toEqual({
      rules: [
        { resource: '<FIXTURE_ROOT>/.opencode/plan/*', effect: 'deny' },
        { resource: '/operator/private', effect: 'allow' },
      ],
    });
  });
});

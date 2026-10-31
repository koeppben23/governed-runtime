/** Only the exact disposable root differs; do not strip arbitrary paths or fields. */
export function normalizeFixturePaths(value, root) {
  if (!root) return value;
  if (typeof value === 'string')
    return value === root ? '<FIXTURE_ROOT>' : value.replaceAll(`${root}/`, '<FIXTURE_ROOT>/');
  if (Array.isArray(value)) return value.map((item) => normalizeFixturePaths(item, root));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeFixturePaths(item, root)]),
    );
  }
  return value;
}

export function compareNativeParity(absent, passive) {
  const a = absent.summary;
  const p = passive.summary;
  const same = (key) =>
    a?.[key] !== undefined &&
    p?.[key] !== undefined &&
    JSON.stringify(a[key]) === JSON.stringify(p[key]);
  const comparisons = {
    hostArtifactUnchanged:
      !!absent.artifact?.sha256 && absent.artifact.sha256 === passive.artifact?.sha256,
    nativeToolsUnchanged: same('tools'),
    modelUnchanged: a?.model === 'probe' && p?.model === 'probe',
    reasoningUnchanged: a?.reasoningEffort === 'high' && p?.reasoningEffort === 'high',
    absentJournalEmpty: absent.journal?.length === 0,
    passiveSetupObserved: p?.journalTypes?.join?.(',') === 'setup:ready',
    passivePluginActive: p?.pluginActive === true,
    absentPluginAbsent: a?.pluginActive === false,
    modelCatalogueUnchanged: same('models'),
    agentPermissionsUnchanged: same('agents'),
  };
  return {
    fixtureStatus:
      absent.passed === true &&
      passive.passed === true &&
      absent.cleaned === true &&
      passive.cleaned === true &&
      Object.values(comparisons).every(Boolean)
        ? 'SUPPORTED'
        : 'NOT_VERIFIED',
    comparisons,
  };
}

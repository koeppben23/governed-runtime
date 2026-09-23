import { describe, expect, it } from 'vitest';

import { analyzeNodeToolchain } from '../check-node-toolchain-consistency.mjs';

const setupWithFile = `      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020
        with:
          node-version-file: .node-version
`;

const setupWithoutFile = `      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020
`;

const setupWithStaticVersion = `      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020
        with:
          node-version: '20'
`;

const localRef = `      - uses: ./.github/actions/prepare-node
`;

function workflow(file: string, steps: string) {
  return {
    file,
    content: `name: ${file}\non: [pull_request]\njobs:\n  job:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`,
  };
}

function action(file: string, steps: string) {
  return {
    file,
    content: `name: Prepare\nruns:\n  using: composite\n  steps:\n${steps}`,
  };
}

const prepareNodeAction = '.github/actions/prepare-node/action.yml';
const installWithBash = `      - run: npm ci\n        shell: bash\n`;

describe('analyzeNodeToolchain', () => {
  it('accepts a direct setup-node step with node-version-file', () => {
    expect(
      analyzeNodeToolchain({
        workflows: [workflow('sdk-compat.yml', setupWithFile)],
        actions: [],
      }),
    ).toEqual([]);
  });

  it('rejects a direct setup-node step without node-version-file', () => {
    const errors = analyzeNodeToolchain({
      workflows: [workflow('sdk-compat.yml', setupWithoutFile)],
      actions: [],
    });
    expect(errors).toContain('sdk-compat.yml: setup-node step without node-version-file');
    expect(errors).toContain('sdk-compat.yml: no node-version-file reference');
  });

  it('rejects a static node-version in a setup-node step', () => {
    const errors = analyzeNodeToolchain({
      workflows: [workflow('sdk-compat.yml', setupWithStaticVersion)],
      actions: [],
    });
    expect(errors.some((error) => error.startsWith('sdk-compat.yml: static node-version'))).toBe(
      true,
    );
  });

  it('accepts an indirect node-version-file proof through a local action', () => {
    expect(
      analyzeNodeToolchain({
        workflows: [workflow('sdk-compat.yml', localRef)],
        actions: [action(prepareNodeAction, setupWithFile + installWithBash)],
      }),
    ).toEqual([]);
  });

  it('rejects an indirect reference whose action installs Node without node-version-file', () => {
    const errors = analyzeNodeToolchain({
      workflows: [workflow('sdk-compat.yml', localRef)],
      actions: [action(prepareNodeAction, setupWithoutFile + installWithBash)],
    });
    expect(errors).toContain(
      '.github/actions/prepare-node/action.yml: setup-node step without node-version-file',
    );
    expect(errors).toContain('sdk-compat.yml: no node-version-file reference');
  });

  it('rejects an unreferenced local action that installs Node without node-version-file', () => {
    const errors = analyzeNodeToolchain({
      workflows: [],
      actions: [action(prepareNodeAction, setupWithoutFile)],
    });
    expect(errors).toEqual([
      '.github/actions/prepare-node/action.yml: setup-node step without node-version-file',
    ]);
  });

  it('follows nested local actions for the indirect proof', () => {
    expect(
      analyzeNodeToolchain({
        workflows: [workflow('sdk-compat.yml', localRef)],
        actions: [
          action(prepareNodeAction, `      - uses: ./.github/actions/install-node\n`),
          action('.github/actions/install-node/action.yml', setupWithFile),
        ],
      }),
    ).toEqual([]);
  });

  it('keeps the matrix allow-list exempt but still checks release.yml', () => {
    expect(
      analyzeNodeToolchain({
        workflows: [workflow('node-compat.yml', setupWithStaticVersion)],
        actions: [],
      }),
    ).toEqual([]);

    expect(
      analyzeNodeToolchain({
        workflows: [workflow('release.yml', setupWithoutFile)],
        actions: [],
      }),
    ).toEqual(['release.yml: missing node-version-file for build job']);

    expect(
      analyzeNodeToolchain({
        workflows: [workflow('release.yml', setupWithFile)],
        actions: [],
      }),
    ).toEqual([]);
  });

  it('fails closed on invalid YAML', () => {
    expect(
      analyzeNodeToolchain({
        workflows: [{ file: 'broken.yml', content: 'jobs: [' }],
        actions: [],
      }),
    ).toEqual(['broken.yml: invalid YAML']);
  });
});

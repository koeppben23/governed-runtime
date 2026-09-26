/**
 * @module architecture/import-specifiers.test
 * @description Contract tests for the shared syntax-based import collector.
 *
 * The collector is the single extraction authority for architecture guards.
 * These fixtures freeze every supported syntax form, the negative cases
 * (comments, strings, computed paths), and the diagnostic fields consumers
 * rely on.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 *
 * @version v1
 */

import { describe, expect, it } from 'vitest';

import { collectImportSpecifiers } from './import-specifiers.js';

function modules(source: string): string[] {
  return collectImportSpecifiers(source).map((specifier) => specifier.module);
}

function kindAndModule(source: string): string[] {
  return collectImportSpecifiers(source).map(
    (specifier) => `${specifier.kind}:${specifier.module}`,
  );
}

describe('collectImportSpecifiers', () => {
  describe('HAPPY — every supported static form', () => {
    it('collects static import declarations', () => {
      const source = [
        `import { a } from './a.js';`,
        `import defaultValue from './default.js';`,
        `import * as ns from './ns.js';`,
        `import './side-effect.js';`,
        `import type { T } from './types.js';`,
      ].join('\n');

      expect(kindAndModule(source)).toEqual([
        'import:./a.js',
        'import:./default.js',
        'import:./ns.js',
        'import:./side-effect.js',
        'import:./types.js',
      ]);
    });

    it('collects re-export declarations', () => {
      const source = [
        `export { a } from './named.js';`,
        `export * from './star.js';`,
        `export * as ns from './star-as.js';`,
        `export type { T } from './types.js';`,
      ].join('\n');

      expect(kindAndModule(source)).toEqual([
        're-export:./named.js',
        're-export:./star.js',
        're-export:./star-as.js',
        're-export:./types.js',
      ]);
    });

    it('collects import-equals require declarations', () => {
      expect(kindAndModule(`import legacy = require('./legacy.js');`)).toEqual([
        'import-equals:./legacy.js',
      ]);
    });

    it('collects dynamic imports with a static module path', () => {
      const source = [
        `const lazy = await import('./lazy.js');`,
        `import('./lazy-two.js');`,
        'import(`./lazy-three.js`);',
      ].join('\n');

      expect(kindAndModule(source)).toEqual([
        'dynamic-import:./lazy.js',
        'dynamic-import:./lazy-two.js',
        'dynamic-import:./lazy-three.js',
      ]);
    });

    it('collects require calls with a static module path', () => {
      const source = [`const cjs = require('./cjs.js');`, `require(\`./cjs-two.js\`);`].join('\n');

      expect(kindAndModule(source)).toEqual(['require:./cjs.js', 'require:./cjs-two.js']);
    });

    it('collects import-type references with a static module path', () => {
      const source = [
        `type Session = import('./schema.js').Session;`,
        `type Probe = typeof import('./probe.js').probe;`,
        'type Lazy = import(`./lazy-types.js`).Lazy;',
      ].join('\n');

      expect(kindAndModule(source)).toEqual([
        'import-type:./schema.js',
        'import-type:./probe.js',
        'import-type:./lazy-types.js',
      ]);
    });

    it('collects bare and Node builtin specifiers (classification stays with consumers)', () => {
      expect(modules(`import * as fs from 'node:fs';\nconst p = require('path');`)).toEqual([
        'node:fs',
        'path',
      ]);
    });
  });

  describe('BAD — comments, strings, and computed paths', () => {
    it('ignores commented-out imports and import-looking string content', () => {
      const source = [
        `// import { x } from './line-comment.js';`,
        `/* export * from './block-comment.js'; */`,
        `/*\nimport { y } from './block-line.js';\n*/`,
        `const text = "import { z } from './string.js'";`,
        "const template = `import { t } from './template.js'`;",
      ].join('\n');

      expect(collectImportSpecifiers(source)).toEqual([]);
    });

    it('skips computed dynamic import paths instead of guessing', () => {
      const source = [
        `import(somePath);`,
        `import('./' + name);`,
        'import(`./${name}.js`);',
        `import(getPath());`,
      ].join('\n');

      expect(collectImportSpecifiers(source)).toEqual([]);
    });

    it('skips computed require paths', () => {
      const source = [`require(runtimePath);`, `require('./' + name);`].join('\n');

      expect(collectImportSpecifiers(source)).toEqual([]);
    });

    it('skips computed import-type paths', () => {
      const source = [`type A = import(someName).A;`, 'type B = import(`./${name}.js`).B;'].join(
        '\n',
      );

      expect(collectImportSpecifiers(source)).toEqual([]);
    });

    it('does not treat require-like property access as a require call', () => {
      const source = [
        `require.resolve('./resolved.js');`,
        `foo.require('./method.js');`,
        `const config = { require: './property.js' };`,
      ].join('\n');

      expect(collectImportSpecifiers(source)).toEqual([]);
    });
  });

  describe('CORNER — comments as trivia and multi-line forms', () => {
    it('collects every form whose module path is separated by a comment', () => {
      const source = [
        `import { x } from /* c */ './c1.js';`,
        `export { x } from /* c */ './c2.js';`,
        `await import(/* c */ './c3.js');`,
        `const x = require(/* c */ './c4.js');`,
        `import legacy = require(/* c */ './c5.js');`,
        `type T = import(/* c */ './c6.js').T;`,
      ].join('\n');

      expect(kindAndModule(source)).toEqual([
        'import:./c1.js',
        're-export:./c2.js',
        'dynamic-import:./c3.js',
        'require:./c4.js',
        'import-equals:./c5.js',
        'import-type:./c6.js',
      ]);
    });

    it('collects multi-line declarations and calls', () => {
      const source = [
        'import {',
        '  a,',
        '  b,',
        `} from './multiline.js';`,
        'const lazy = await import(',
        `  './multiline-lazy.js'`,
        ');',
      ].join('\n');

      expect(modules(source)).toEqual(['./multiline.js', './multiline-lazy.js']);
    });

    it('keeps the statement text in raw so diagnostic matchers stay effective', () => {
      const source = `import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';`;
      const [specifier] = collectImportSpecifiers(source);

      expect(specifier?.raw).toContain('import');
      expect(specifier?.raw).toContain("'../shared/flowguard-identifiers.js'");
      expect(specifier?.raw).toMatch(/import\s*\{\s*REVIEWER_SUBAGENT_TYPE\s*\}\s*from/);
    });

    it('keeps import-type and re-export markers in raw', () => {
      const typeSpecifier = collectImportSpecifiers(`import type { A } from './a.js';`)[0];
      expect(typeSpecifier?.raw).toContain('import type');

      const reExport = collectImportSpecifiers(`export * from './star.js';`)[0];
      expect(reExport?.raw).toContain('export *');
      expect(reExport?.raw).toContain('export');
    });

    it('collects each occurrence without deduplication', () => {
      const source = [`import './dup.js';`, `import './dup.js';`].join('\n');
      expect(modules(source)).toEqual(['./dup.js', './dup.js']);
    });
  });

  describe('EDGE — empty and ordering', () => {
    it('returns no specifiers for empty or comment-only source', () => {
      expect(collectImportSpecifiers('')).toEqual([]);
      expect(collectImportSpecifiers('// only a comment\n')).toEqual([]);
      expect(collectImportSpecifiers('const x = 1;\n')).toEqual([]);
    });

    it('preserves source order across mixed forms', () => {
      const source = [
        `import './first.js';`,
        `export * from './second.js';`,
        `const third = require('./third.js');`,
        `await import('./fourth.js');`,
      ].join('\n');

      expect(modules(source)).toEqual(['./first.js', './second.js', './third.js', './fourth.js']);
    });

    it('collects require calls that are not at the start of a line', () => {
      const source = `const midLine = require('./mid-line.js');`;
      expect(kindAndModule(source)).toEqual(['require:./mid-line.js']);
    });

    it('collects requires nested in expressions', () => {
      const source = `module.exports = require('./nested.js').create();`;
      expect(kindAndModule(source)).toEqual(['require:./nested.js']);
    });
  });
});

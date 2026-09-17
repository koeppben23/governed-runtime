import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ['src/**/*.test.ts', 'src/**/__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
    },
  },
  {
    // Default-wide type-aware correctness: every TypeScript file under src/,
    // including tests. Do NOT narrow this to a directory allowlist — the scope
    // is pinned by src/architecture/__tests__/type-aware-lint-scope.test.ts.
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        // Type-aware coverage for production and test files alike. The two
        // projects partition src/: tsconfig.json owns production sources and
        // excludes tests, tsconfig.test.json owns the test files (the project
        // service alone discovers only tsconfig.json, and its default-project
        // escape hatch is capped at a handful of files).
        project: ['./tsconfig.json', './tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        {
          checksVoidReturn: false,
        },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },
  {
    // Maintainability metrics: default-wide for production code under src/.
    // Tests are excluded as a file class (suites are allowed to be broader),
    // never by directory allowlist. Thresholds are repository-wide ceilings
    // calibrated against the measured distribution (see PR 2b); the tail above
    // them is refactored, never exempted. They do not use type information.
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts', 'src/**/__tests__/**/*.ts'],
    rules: {
      'max-params': ['warn', { max: 5 }],
      complexity: ['warn', { max: 25 }],
      'max-lines-per-function': ['warn', { max: 120, skipBlankLines: true, skipComments: true }],
    },
  },
);

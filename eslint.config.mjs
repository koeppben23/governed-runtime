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
    // Tests and internal test support are excluded as file classes (suites and
    // fixtures are allowed to be broader), never by an ad-hoc directory
    // allowlist. These patterns are the declarative projection of
    // `isTestSourcePath`; the projection is enforced by
    // src/architecture/__tests__/type-aware-lint-scope.test.ts against the
    // effective config.
    //
    // 12 / 80 / 5 ARE the enforced clean-code limits — not a transitional
    // ceiling. The former monotonic maintainability ratchet and its baseline
    // were removed once the debt reached zero; `lint:strict` (max-warnings=0)
    // is now the single enforcement authority for these metrics, and
    // src/architecture/__tests__/type-aware-lint-scope.test.ts pins the values
    // and the production file-class scope against the effective config.
    // Rules do not use type information.
    files: ['src/**/*.ts'],
    ignores: [
      'src/**/*.test.ts',
      'src/**/*.spec.ts',
      'src/**/__tests__/**/*.ts',
      'src/**/__fixtures__/**/*.ts',
      'src/**/*-test-helpers.ts',
      'src/**/test-helpers.ts',
      'src/**/*-test-fixtures.ts',
      'src/**/evidence-test-constants.ts',
      'src/fixtures.ts',
      'src/fixtures/**/*.ts',
      'src/test-policy.ts',
      'src/architecture/**/*.ts',
      'src/documentation/**/*.ts',
      'src/security/**/*.ts',
    ],
    rules: {
      // Zero-debt syntax invariant for production: non-null assertions must be
      // replaced by real narrowing. Test suites keep the syntax for fixtures.
      '@typescript-eslint/no-non-null-assertion': 'error',
      'max-params': ['warn', { max: 5 }],
      complexity: ['warn', { max: 12 }],
      'max-lines-per-function': ['warn', { max: 80, skipBlankLines: true, skipComments: true }],
    },
  },
);

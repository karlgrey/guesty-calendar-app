// ESLint 9 flat config (the project previously had no working ESLint config).
// Uses the installed @typescript-eslint parser + plugin, recommended (non-type-checked) ruleset.
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'public/**', 'data/**', 'coverage/**', '*.config.js'],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,

      // Dynamic Guesty/Hostex JSON and Express handlers use `any` pervasively and
      // intentionally; surface it as a warning rather than failing the build.
      '@typescript-eslint/no-explicit-any': 'warn',

      // Allow underscore-prefixed intentionally-unused bindings (args, vars, caught errors,
      // and dropped keys in array destructuring).
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      }],

      // Ambient declaration-merging (e.g. src/types/express.d.ts augmenting Express)
      // legitimately needs `namespace` and empty interfaces.
      '@typescript-eslint/no-namespace': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
];

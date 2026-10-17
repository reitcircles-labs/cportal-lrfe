// Lint rules for the whole repository: the Google TypeScript Style Guide
// (https://google.github.io/styleguide/tsguide.html), as explained in docs/coding-guide.md.
// Formatting is left to Prettier (.prettierrc.json); eslint-config-prettier switches off the
// rules that would disagree with it.
import eslint from '@eslint/js';
import angular from 'angular-eslint';
import prettier from 'eslint-config-prettier';
import jsdoc from 'eslint-plugin-jsdoc';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Rules from the guide that apply to JavaScript and TypeScript alike. */
const COMMON_RULES = {
  // Variables: const and let only, const where the value never changes.
  'no-var': 'error',
  'prefer-const': 'error',
  // === everywhere; the guide allows == null, which covers null and undefined at once.
  eqeqeq: ['error', 'always', {null: 'ignore'}],
  // Braces on every block; an if that fits on one line may leave them out, as the guide
  // allows. If Prettier wraps such an if onto two lines, `npm run lint:fix` adds the braces.
  curly: ['error', 'multi-line'],
  // One variable per declaration.
  'one-var': ['error', 'never'],
  'no-new-wrappers': 'error',
  'no-throw-literal': 'error',
  'prefer-rest-params': 'error',
  'prefer-spread': 'error',
  'no-restricted-syntax': [
    'error',
    {
      selector: 'ExportDefaultDeclaration',
      message: 'Use named exports; the guide does not allow default exports.',
    },
    {
      selector: 'ForInStatement',
      message: 'Use for...of with Object.keys/entries instead of for...in.',
    },
  ],
  // JSDoc on exported functions and classes, including `export const f = () => ...`.
  'jsdoc/require-jsdoc': [
    'warn',
    {
      publicOnly: true,
      require: {
        FunctionDeclaration: true,
        ClassDeclaration: true,
        ArrowFunctionExpression: true,
        FunctionExpression: true,
      },
    },
  ],
  // Adding a cause to a rethrown error changes what is logged and returned; that is decided
  // case by case, not in a style change.
  'preserve-caught-error': 'off',
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/',
      '**/dist/',
      '**/.angular/',
      '**/out-tsc/',
      '**/coverage/',
      'backend/.tools/',
      'e2e/.stack/',
      'e2e/evidence/',
      'e2e/playwright-report/',
      'e2e/test-results/',
      'deploy/dist/',
    ],
  },

  // JavaScript: the backend services and packages, and the scripts around the apps.
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [eslint.configs.recommended, prettier],
    plugins: {jsdoc},
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {...globals.node},
    },
    rules: {
      ...COMMON_RULES,
      // Data from the database and from documents keeps its own names (snake_case), so only
      // our own variables are checked.
      camelcase: [
        'error',
        {properties: 'never', ignoreDestructuring: true, ignoreImports: true},
      ],
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrors: 'none',
          ignoreRestSiblings: true,
        },
      ],
    },
  },

  // TypeScript: the web app and the end-to-end tests.
  {
    files: ['**/*.ts'],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.recommended,
      prettier,
    ],
    plugins: {jsdoc},
    rules: {
      ...COMMON_RULES,
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrors: 'none',
          ignoreRestSiblings: true,
        },
      ],
      // T[] for simple types, Array<T> for complex ones.
      '@typescript-eslint/array-type': ['error', {default: 'array-simple'}],
      // Interfaces for object types, not type aliases.
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      // No `public` modifier: members are public unless marked otherwise.
      '@typescript-eslint/explicit-member-accessibility': [
        'error',
        {accessibility: 'no-public'},
      ],
      'no-restricted-syntax': [
        ...COMMON_RULES['no-restricted-syntax'],
        {
          selector: 'TSEnumDeclaration[const=true]',
          message: 'Use a plain enum; the guide does not allow const enum.',
        },
        {
          selector: 'PropertyDefinition > PrivateIdentifier',
          message: 'Use the TypeScript private modifier, not #private fields.',
        },
        {
          selector: 'MethodDefinition > PrivateIdentifier',
          message: 'Use the TypeScript private modifier, not #private methods.',
        },
      ],
      '@typescript-eslint/naming-convention': [
        'error',
        // No _ prefix or suffix, except on parameters that are deliberately unused.
        {selector: 'default', format: ['camelCase']},
        {
          selector: 'parameter',
          format: ['camelCase'],
          leadingUnderscore: 'allow',
        },
        {selector: 'typeLike', format: ['PascalCase']},
        {selector: 'enumMember', format: ['UPPER_CASE']},
        // Constants may be CONSTANT_CASE, and component-like values PascalCase.
        {
          selector: 'variable',
          format: ['camelCase', 'UPPER_CASE', 'PascalCase'],
        },
        {selector: 'import', format: null},
        // Object keys and properties often mirror API payloads, CSS, or headers.
        {
          selector: [
            'objectLiteralProperty',
            'typeProperty',
            'objectLiteralMethod',
          ],
          format: null,
        },
        {
          selector: 'classProperty',
          modifiers: ['static', 'readonly'],
          format: ['camelCase', 'UPPER_CASE'],
        },
      ],
    },
  },

  // The web app: Angular's own rules, including those for the inline templates.
  {
    files: ['angular-app/src/**/*.ts'],
    extends: [...angular.configs.tsRecommended],
    processor: angular.processInlineTemplates,
    languageOptions: {globals: {...globals.browser}},
    rules: {
      // OnPush changes when screens update; that is a behaviour change, not style, so it is
      // decided per component outside the style tickets.
      '@angular-eslint/prefer-on-push-component-change-detection': 'off',
    },
  },
  {
    files: ['angular-app/src/**/*.html'],
    extends: [...angular.configs.templateRecommended],
  },

  // Unit tests and e2e tests read better with a few looser rules.
  {
    files: [
      '**/*.test.js',
      '**/*.test.mjs',
      '**/*.test.ts',
      'e2e/**/*.ts',
      'e2e/**/*.mjs',
    ],
    rules: {'jsdoc/require-jsdoc': 'off'},
  },
  {
    files: ['backend/**/tests/**/*.js'],
    languageOptions: {globals: {...globals.mocha}},
  },
  {
    files: [
      'e2e/**/*.ts',
      'e2e/**/*.mjs',
      'angular-app/docs/**/*.mjs',
      'demo/**/*.mjs',
    ],
    languageOptions: {globals: {...globals.node, ...globals.browser}},
  },

  // Tool configuration files must default-export their configuration.
  {
    files: ['eslint.config.mjs', '**/*.config.ts', 'e2e/stack/proxy.e2e.mjs'],
    rules: {'no-restricted-syntax': 'off'},
  },
);

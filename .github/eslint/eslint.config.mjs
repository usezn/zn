import js from '@eslint/js';
import globals from 'globals';

// Lint config for packages/zn-gate (CommonJS, Node.js 18 or later).
// Run from .github/eslint: npx eslint --no-warn-ignored -c eslint.config.mjs ../../packages/zn-gate
export default [
  { ignores: ['**/node_modules/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      // Unused function parameters are allowed (callbacks and test doubles keep the
      // signature of what they stand in for). A leading underscore marks an unused
      // variable on purpose, and an unused catch binding ignores an error on purpose.
      'no-unused-vars': ['error', { args: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // Tests write runs of spaces inside regular expressions to match aligned output.
      'no-regex-spaces': 'off',
      // The scanners match control characters on purpose.
      'no-control-regex': 'off',
      // Many patterns escape a slash or brace for readability; the escapes are harmless.
      'no-useless-escape': 'off',
      // Some patterns hold invisible or combining characters on purpose, because they
      // detect hidden-character tricks in text.
      'no-irregular-whitespace': 'off',
      'no-misleading-character-class': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];

// Correctness checks only; no stylistic or formatting rules.
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    files: ['src/**/*.js', 'deploy-commands.js', 'eslint.config.js', 'tests/**/*.{js,mjs}', 'portal/server/**/*.js'],
    ...js.configs.recommended,
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node },
    rules: {
      ...js.configs.recommended.rules,
      // Input sanitizers match control characters on purpose.
      'no-control-regex': 'off',
      // Best-effort cleanup (closing handles, replying after a failure) ignores errors on purpose.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // `const { flags, ...rest } = payload` drops a field; `_name` marks a deliberate unused binding.
      'no-unused-vars': ['error', { ignoreRestSiblings: true, argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
];

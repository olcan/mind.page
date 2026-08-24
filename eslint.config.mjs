import js from '@eslint/js'
import globals from 'globals'

// plain-javascript lint only: svelte/typescript sources are covered by `npm run check` (svelte-check)
// and `npm run check:tests` (tsc), so eslint keeps the untyped node scripts honest
export default [
  // lib/ holds tsc-compiled cloud function output (generated code); src/vendor is third-party
  { ignores: ['node_modules', 'build', '.svelte-kit', 'functions/node_modules', 'static', 'ssl-dev', 'lib', 'src/vendor'] },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      // lodash is a preloaded app global (see client-globals.ts)
      globals: { ...globals.node, ...globals.browser, _: 'readonly' },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-useless-escape': 'off', // legacy regexes escape delimiters for readability
      'no-useless-assignment': 'off', // timing instrumentation assigns checkpoints conditionally read
    },
  },
]

import js from '@eslint/js';

const nodeGlobals = Object.fromEntries(
  [
    'process',
    'Buffer',
    'console',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    'setImmediate',
    'clearImmediate',
    'fetch',
    'AbortSignal',
    'AbortController',
    'URL',
    'URLSearchParams',
    'TextEncoder',
    'TextDecoder',
    'structuredClone',
    'Response',
    'Request',
    'Headers',
  ].map((name) => [name, 'readonly']),
);

export default [
  { ignores: ['node_modules/**', 'coverage/**', 'dist/**'] },
  js.configs.recommended,
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: nodeGlobals },
    rules: {
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // These expressions explicitly reject control characters in user input.
      'no-control-regex': 'off',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
    },
  },
];

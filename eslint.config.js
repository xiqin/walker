'use strict';

const globals = require('globals');

module.exports = [
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // 来自 eslint:recommended 的关键规则（ESLint 10 默认已含 recommended）
      'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-implicit-globals': 'error',
      'no-undef': 'error',
      'no-redeclare': 'error',
      'no-unreachable': 'error',
      'no-control-regex': 'error',
      'no-dupe-keys': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],

      // 风格规则（与现有约定一致：调研结果 97% 分号、91% 单引号、99.6% ===、全空格）
      'semi': ['error', 'always'],
      'quotes': ['error', 'single', { allowTemplateLiterals: true, avoidEscape: true }],
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'no-tabs': 'error',
      'indent': ['error', 2, { SwitchCase: 1 }],
      'comma-dangle': ['error', 'always-multiline'],
      'no-trailing-spaces': 'error',
      'eol-last': ['error', 'always'],
    },
    ignores: [
      'node_modules/**',
      'specs/**',
      '.loom/**',
      'src/admin/public/app.js',
    ],
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.mocha,
      },
    },
  },
];

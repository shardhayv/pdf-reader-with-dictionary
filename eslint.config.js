'use strict';
const globals = require('globals');

module.exports = [
  {
    ignores: ['node_modules/**', 'dist/**', 'test/fixtures/**', 'test/screenshots/**',
      'test-results/**', 'playwright-report/**'],
  },

  // Main process and packaging scripts — CommonJS with Node globals.
  {
    files: ['main.js', 'preload.js', 'main/**/*.js', 'scripts/**/*.js',
      'playwright.config.js', 'eslint.config.js', 'about.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-undef': 'error',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  // Renderer — ES modules in a browser context, plus the preload bridge.
  {
    files: ['renderer/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        Highlight: 'readonly',
        gloss: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-undef': 'error',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  // Tests.
  {
    files: ['test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_' }] },
  },
  {
    files: ['test/unit/**/*.js'],
    languageOptions: { sourceType: 'module' },
  },
];

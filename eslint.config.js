'use strict'

const js = require('@eslint/js')
const globals = require('globals')

module.exports = [
  // Vendored third-party bundle (Leaflet); not ours to lint.
  { ignores: ['public/vendor/**'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    rules: {
      // Unused function args and catch bindings are fine (route/callback shape).
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }]
    }
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, L: 'readonly' } }
  },
  {
    files: ['test/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.mocha } }
  }
]

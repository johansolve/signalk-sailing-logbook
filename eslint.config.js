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
    // export.js is a second classic script sharing app.js's global scope, so the
    // helpers it borrows from there have to be declared here.
    files: ['public/export.js'],
    languageOptions: {
      globals: {
        Mp4Muxer: 'readonly',
        READ: 'readonly', getJSON: 'readonly', t: 'readonly', n: 'readonly',
        toKnots: 'readonly', fmtDate: 'readonly', fmtTime: 'readonly',
        fmtDuration: 'readonly', placeOf: 'readonly', sogColor: 'readonly',
        pb: 'readonly', pbBearing: 'readonly', pbPauseAfter: 'readonly',
        pbRenderToggle: 'readonly', pbLoop: 'readonly',
        PB_SEC_PER_HOUR: 'readonly', PB_NIGHT_PAUSE_MS: 'readonly'
      }
    }
  },
  {
    files: ['test/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.mocha } }
  }
]

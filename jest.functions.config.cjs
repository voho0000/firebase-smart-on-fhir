// Jest config for the Cloud Functions middleware tests (auth / quota / cors).
//
// Config + tests live at the firebase repo ROOT because the functions/ directory
// is owned by root (can't create files inside it here). functions/src is still
// world-readable, so the tests import it directly; firebase-admin /
// firebase-functions / ts-jest are resolved from functions/node_modules via
// modulePaths + require.resolve.
const path = require('path')
const fnNodeModules = path.join(__dirname, 'functions', 'node_modules')

module.exports = {
  rootDir: __dirname,
  testEnvironment: 'node',
  testMatch: ['<rootDir>/functions-test/**/*.test.ts'],
  modulePaths: [fnNodeModules],
  transform: {
    '^.+\\.ts$': [
      require.resolve('ts-jest', { paths: [fnNodeModules] }),
      {
        tsconfig: path.join(__dirname, 'functions', 'tsconfig.json'),
        // Transpile-only: production `tsc` already type-checks.
        diagnostics: false,
      },
    ],
  },
}

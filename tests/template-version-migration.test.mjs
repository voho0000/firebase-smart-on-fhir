import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import test from 'node:test'
import assert from 'node:assert/strict'
const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, deleteApp } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')

test('version backfill is dry-run by default, preserves fields, and is idempotent', async () => {
  const projectId = 'demo-template-version-migration'
  process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080'
  const app = initializeApp({ projectId }, 'template-version-migration-test')
  const db = getFirestore(app, 'mediprisma')
  const timestamp = new Date('2026-09-01T00:00:00Z')
  await db.doc('sharedPrompts/legacy').set({ prompt: 'Original', updatedAt: timestamp })
  await db.doc('sharedPrompts/versioned').set({ prompt: 'Current', version: 4, updatedAt: timestamp })
  await db.doc('tenantPrompts/legacy').set({ prompt: 'Department', updatedAt: timestamp })

  const run = (...args) => spawnSync(process.execPath, ['functions/scripts/backfill-template-versions.mjs', `--project=${projectId}`, '--database=mediprisma', ...args], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', env: process.env,
  })
  try {
    assert.equal(run().status, 0)
    assert.equal((await db.doc('sharedPrompts/legacy').get()).get('version'), undefined)
    assert.notEqual(run('--apply').status, 0)
    assert.equal(run('--apply', `--confirm-project=${projectId}`).status, 0)
    const migrated = (await db.doc('sharedPrompts/legacy').get()).data()
    assert.equal(migrated.prompt, 'Original')
    assert.equal(migrated.version, 1)
    assert.equal(migrated.updatedAt.toDate().toISOString(), timestamp.toISOString())
    assert.equal((await db.doc('sharedPrompts/versioned').get()).get('version'), 4)
    assert.equal((await db.doc('tenantPrompts/legacy').get()).get('version'), 1)
    assert.match(run('--apply', `--confirm-project=${projectId}`).stdout, /Updated 0 templates/)
  } finally { await deleteApp(app) }
})

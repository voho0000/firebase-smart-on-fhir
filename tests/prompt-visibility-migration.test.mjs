import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import test from 'node:test'
import assert from 'node:assert/strict'
import { initializeTestEnvironment, assertFails } from '@firebase/rules-unit-testing'
const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, deleteApp } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')

test('legacy public templates return after migration; private content and repeated runs are preserved', async () => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'This test requires the Firestore emulator')
  const projectId = 'demo-gallery-migration'
  const env = await initializeTestEnvironment({ projectId, firestore: {
    rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'),
  } })
  const script = fileURLToPath(new URL('../functions/scripts/backfill-shared-prompt-visibility.mjs', import.meta.url))
  const app = initializeApp({ projectId }, 'migration-test')
  const db = getFirestore(app, 'mediprisma')
  const run = (...args) => execFileSync(process.execPath, [script, ...args], {
    env: { ...process.env, FIREBASE_CONFIG: JSON.stringify({ projectId }), GOOGLE_CLOUD_PROJECT: projectId, GCLOUD_PROJECT: projectId }, encoding: 'utf8',
  })
  try {
    await env.clearFirestore()
    // The production migration intentionally targets the named database.
    {
      await db.doc('sharedPrompts/legacy').set({ title: 'HMC SOAP DNA', prompt: 'Original content', authorId: 'author', types: ['chat'] })
      await db.doc('sharedPrompts/private').set({ title: 'Private', prompt: 'Private content', authorId: 'author', isPublic: false })
      await db.doc('sharedPrompts/public').set({ title: 'Public', prompt: 'Published content', isPublic: true })
    }
    const read = async () => {
      const snapshot = await db.collection('sharedPrompts').get()
      return Object.fromEntries(snapshot.docs.map(doc => [doc.id, doc.data()]))
    }
    const before = await read()
    await env.withSecurityRulesDisabled(async context => {
      for (const [id, data] of Object.entries(before)) await context.firestore().doc(`sharedPrompts/${id}`).set(data)
    })
    const publicDb = env.unauthenticatedContext().firestore()
    assert.deepEqual((await publicDb.collection('sharedPrompts').where('isPublic', '==', true).get()).docs.map(doc => doc.id), ['public'])
    await assertFails(publicDb.doc('sharedPrompts/legacy').get())
    assert.match(run(), /Found 1 shared prompts/)
    assert.deepEqual(await read(), before, 'dry-run must not write')
    assert.match(run('--apply'), /Updated 1 shared prompts/)
    assert.deepEqual(await read(), { ...before, legacy: { ...before.legacy, isPublic: true } })
    assert.match(run('--apply'), /Updated 0 shared prompts/)
    assert.deepEqual(await read(), { ...before, legacy: { ...before.legacy, isPublic: true } })
    // Rules testing uses the default database; verify the same migrated records
    // through the public reader with the deployed rules loaded by the test env.
    await env.withSecurityRulesDisabled(async context => {
      for (const [id, data] of Object.entries({ ...before, legacy: { ...before.legacy, isPublic: true } })) {
        await context.firestore().doc(`sharedPrompts/${id}`).set(data)
      }
    })
    assert.deepEqual((await publicDb.collection('sharedPrompts').where('isPublic', '==', true).get()).docs.map(doc => doc.id).sort(), ['legacy', 'public'])
    await assertFails(publicDb.doc('sharedPrompts/private').get())
  } finally { await env.cleanup(); await deleteApp(app) }
})

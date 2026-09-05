import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { before, after, beforeEach } from 'node:test'
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing'

let env
before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-prompt-favorites',
    firestore: { rules: readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'firestore.rules'), 'utf8') } })
})
after(async () => { await env?.cleanup() })
beforeEach(async () => { await env.clearFirestore() })
const user = (id = 'alice') => env.authenticatedContext(id, { firebase: { sign_in_provider: 'password' } }).firestore()
const anon = (id = 'ghost') => env.authenticatedContext(id, { firebase: { sign_in_provider: 'anonymous' } }).firestore()
const guest = () => env.unauthenticatedContext().firestore()
const favorite = () => ({ order: -1, savedAt: new Date(), sourceUpdatedAt: new Date(), sourceCreatedAt: new Date(),
  title: 'Saved copy', description: null, prompt: 'Full text', types: ['chat'], category: 'summary', specialty: ['general'],
  audience: ['medical'], tags: [], outputFormat: null, languagePolicy: null, exampleOutput: null,
  authorId: 'dept', authorName: 'Cardiology', isAnonymous: false })
const shared = (overrides = {}) => ({ title: 'Template', prompt: 'Source', types: ['summary'], category: 'summary',
  specialty: ['general'], audience: ['medical'], tags: [], authorId: 'alice', usageCount: 0,
  createdAt: new Date(), updatedAt: new Date(), outputFormat: 'markdown', ...overrides })

test('a favorite is a private per-account copy', async () => {
  const mine = user('alice').doc('users/alice/promptFavorites/p1')
  await assertSucceeds(mine.set(favorite()))
  await assertSucceeds(mine.get())
  await assertFails(user('bob').doc('users/alice/promptFavorites/p1').get())
  await assertFails(user('bob').doc('users/alice/promptFavorites/p2').set(favorite()))
  await assertFails(guest().doc('users/alice/promptFavorites/p3').set(favorite()))
  await assertSucceeds(mine.delete())
})

test('favorites are unaffected by the shared source being deleted', async () => {
  await assertSucceeds(user('alice').doc('sharedPrompts/src').set(shared()))
  await assertSucceeds(user('bob').doc('users/bob/promptFavorites/src').set(favorite()))
  await assertSucceeds(user('alice').doc('sharedPrompts/src').delete())
  await assertSucceeds(user('bob').doc('users/bob/promptFavorites/src').get())
})

test('anonymous sessions may keep favorites under their own uid only', async () => {
  await assertSucceeds(anon('ghost').doc('users/ghost/promptFavorites/p').set(favorite()))
  await assertFails(anon('ghost').doc('users/alice/promptFavorites/p').set(favorite()))
})

test('shared prompts accept an optional bounded example output', async () => {
  const ref = user().doc('sharedPrompts/p')
  await assertSucceeds(ref.set(shared({ exampleOutput: '## Sample\n- item' })))
  await assertSucceeds(ref.update({ exampleOutput: 'Revised sample', updatedAt: new Date() }))
  await assertFails(user().doc('sharedPrompts/q').set(shared({ exampleOutput: 42 })))
  await assertFails(user().doc('sharedPrompts/r').set(shared({ exampleOutput: 'x'.repeat(20001) })))
  await assertFails(user('bob').doc('sharedPrompts/p').update({ exampleOutput: 'Not the author' }))
})

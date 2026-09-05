import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing'

let env
before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-gallery-sharing',
    firestore: { rules: readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'firestore.rules'), 'utf8') } })
})
after(async () => { await env?.cleanup() })
beforeEach(async () => { await env.clearFirestore() })
const user = (id = 'alice') => env.authenticatedContext(id, { firebase: { sign_in_provider: 'password' } }).firestore()
const guest = () => env.unauthenticatedContext().firestore()
const data = (overrides = {}) => ({ title: 'Template', prompt: 'Source', types: ['summary'], category: 'summary',
  specialty: ['general'], audience: ['medical'], tags: [], authorId: 'alice', usageCount: 0,
  createdAt: new Date(), updatedAt: new Date(), outputFormat: 'html', ...overrides })

for (const [field, value] of [['title', 42], ['prompt', {}], ['tags', [42]], ['types', ['unknown']],
  ['specialty', ['unknown']], ['audience', []], ['usageCount', 12], ['outputFormat', 'script'],
  ['createdAt', 'today'], ['unexpected', 'extra']]) {
  test('rejects malformed public ' + field, async () => {
    await assertFails(user().doc('sharedPrompts/p').set(data({ [field]: value })))
  })
}

test('author can edit content but cannot replace ownership, createdAt, or usageCount', async () => {
  const ref = user().doc('sharedPrompts/p')
  await assertSucceeds(ref.set(data()))
  await assertSucceeds(ref.update({ title: 'Updated', updatedAt: new Date() }))
  for (const patch of [{ authorId: 'bob' }, { createdAt: new Date(0) }, { usageCount: 999999 }, { title: 'Counter bypass', usageCount: 999999 }]) {
    await assertFails(ref.update(patch))
  }
  await assertSucceeds(ref.update({ usageCount: 1 }))
  await assertFails(user('bob').doc('sharedPrompts/p').update({ title: 'Other author' }))
  await assertFails(user('bob').doc('sharedPrompts/p').delete())
})

test('anonymous presentation cannot include a public author name', async () => {
  await assertFails(user().doc('sharedPrompts/p').set(data({ isAnonymous: true, authorName: 'Alice' })))
  await assertSucceeds(user().doc('sharedPrompts/p').set(data({ isAnonymous: true })))
})

test('body is private until complete publication; chunk content stays immutable', async () => {
  const db = user()
  const body = db.doc('templateBodies/body')
  const text = '中😀'.repeat(180000)
  const chunks = []
  for (let start = 0; start < text.length; start += 60000) chunks.push(text.slice(start, start + 60000))
  const metadata = { ownerId: 'alice', scope: 'shared', promptId: 'p', chunks: chunks.length, length: text.length, ready: false }
  await assertSucceeds(body.set(metadata))
  const shared = data({ prompt: 'Preview', body: { id: 'body', chunks: chunks.length, length: text.length } })
  await assertFails(db.doc('sharedPrompts/p').set(shared))
  await assertFails(guest().doc('templateBodies/body').get())
  for (let index = 0; index < chunks.length; index++) {
    await assertSucceeds(body.collection('chunks').doc(String(index)).set({ index, text: chunks[index] }))
  }
  await assertFails(user('bob').doc('templateBodies/body/chunks/0').get())
  await assertSucceeds(body.update({ ready: true }))
  await assertSucceeds(db.doc('sharedPrompts/p').set(shared))
  await assertSucceeds(guest().doc('templateBodies/body').get())
  const readBack = await Promise.all(chunks.map((_, index) => guest().doc('templateBodies/body/chunks/' + index).get()))
  assert.equal(readBack.map(snapshot => snapshot.data().text).join(''), text)
  await assertFails(body.collection('chunks').doc('0').update({ text: 'Changed' }))
  await assertFails(body.collection('chunks').doc('0').delete())
  await assertFails(body.delete())
  await assertSucceeds(db.doc('sharedPrompts/p').delete())
  await assertFails(guest().doc('templateBodies/body/chunks/0').get())
  await assertSucceeds(body.collection('chunks').doc('0').delete())
})

test('cannot publish another author body or a mismatched manifest', async () => {
  await user().doc('templateBodies/body').set({ ownerId: 'alice', scope: 'shared', promptId: 'p', chunks: 1, length: 6, ready: false })
  await user().doc('templateBodies/body/chunks/0').set({ index: 0, text: 'Source' })
  await user().doc('templateBodies/body').update({ ready: true })
  await assertFails(user('bob').doc('sharedPrompts/p').set(data({ authorId: 'bob', body: { id: 'body', chunks: 1, length: 6 } })))
  await assertFails(user().doc('sharedPrompts/p').set(data({ body: { id: 'body', chunks: 2, length: 6 } })))
})

test('private imported template bodies remain owner-only', async () => {
  const ref = user().doc('templateBodies/private')
  await assertSucceeds(ref.set({ ownerId: 'alice', scope: 'private', collectionName: 'chatTemplates', itemId: 'private', chunks: 1, length: 6, ready: false }))
  await assertSucceeds(ref.collection('chunks').doc('0').set({ index: 0, text: 'Source' }))
  await assertSucceeds(ref.update({ ready: true }))
  await assertSucceeds(ref.collection('chunks').doc('0').get())
  await assertFails(user('bob').doc('templateBodies/private/chunks/0').get())
  await assertFails(guest().doc('templateBodies/private/chunks/0').get())
  await user().doc('users/alice/chatTemplates/private').set({ textBody: { id: 'private', chunks: 1, length: 6 } })
  await assertFails(ref.collection('chunks').doc('0').delete())
  await assertFails(ref.delete())
  await user().doc('users/alice/chatTemplates/private').delete()
  await assertSucceeds(ref.collection('chunks').doc('0').delete())
  await assertSucceeds(ref.delete())
})

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing'
import { collection, getDocs, orderBy, query, where } from 'firebase/firestore'

let env
before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-tenant-prompts',
    firestore: { rules: readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'firestore.rules'), 'utf8') } })
})
after(async () => { await env?.cleanup() })
const user = (id) => env.authenticatedContext(id, { firebase: { sign_in_provider: 'password' } }).firestore()
const anon = (id) => env.authenticatedContext(id, { firebase: { sign_in_provider: 'anonymous' } }).firestore()
const seed = (fn) => env.withSecurityRulesDisabled((ctx) => fn(ctx.firestore()))
const membership = (uid, tenant, role, status = 'active') => ({ uid, tenant_id: tenant, role, status, display_name: 'Cardiology' })
const prompt = (overrides = {}) => ({ title: 'HF follow-up', prompt: 'Summarise NT-proBNP trend', types: ['chat'], category: 'summary',
  specialty: ['cardiology'], audience: ['medical'], tags: [], authorId: 'builder', usageCount: 0,
  createdAt: new Date(), updatedAt: new Date(), tenantId: 'cardio', ...overrides })

beforeEach(async () => {
  await env.clearFirestore()
  await seed(async (db) => {
    await db.doc('users/owner/memberships/cardio').set(membership('owner', 'cardio', 'owner'))
    await db.doc('users/builder/memberships/cardio').set(membership('builder', 'cardio', 'builder'))
    await db.doc('users/member/memberships/cardio').set(membership('member', 'cardio', 'member'))
    await db.doc('users/former/memberships/cardio').set(membership('former', 'cardio', 'member', 'disabled'))
    await db.doc('users/nephro/memberships/nephro').set(membership('nephro', 'nephro', 'owner'))
  })
})

test('only owner and builder members publish, edit and retire department templates', async () => {
  await assertSucceeds(user('builder').doc('tenantPrompts/p1').set(prompt()))
  await assertSucceeds(user('owner').doc('tenantPrompts/p2').set(prompt({ authorId: 'owner' })))
  await assertFails(user('member').doc('tenantPrompts/p3').set(prompt({ authorId: 'member' })))
  await assertFails(user('nephro').doc('tenantPrompts/p4').set(prompt({ authorId: 'nephro' })))
  await assertFails(user('builder').doc('tenantPrompts/p5').set(prompt({ tenantId: 'nephro' })))
  await assertFails(user('builder').doc('tenantPrompts/p6').set(prompt({ authorId: 'owner' })))
  await assertFails(user('builder').doc('tenantPrompts/p7').set(prompt({ body: { id: 'b', chunks: 1, length: 1 } })))
  await assertSucceeds(user('owner').doc('tenantPrompts/p1').update({ title: 'Renamed', updatedAt: new Date() }))
  await assertFails(user('member').doc('tenantPrompts/p1').update({ title: 'Member edit', updatedAt: new Date() }))
  await assertFails(user('owner').doc('tenantPrompts/p1').update({ tenantId: 'nephro', updatedAt: new Date() }))
  await assertFails(user('member').doc('tenantPrompts/p1').delete())
  await assertSucceeds(user('owner').doc('tenantPrompts/p1').delete())
})

test('department templates are visible to active members only, including list queries', async () => {
  await seed((db) => db.doc('tenantPrompts/p1').set(prompt()))
  const list = (db) => getDocs(query(collection(db, 'tenantPrompts'), where('tenantId', '==', 'cardio'), orderBy('createdAt', 'desc')))
  const rows = await assertSucceeds(list(user('member')))
  assert.equal(rows.size, 1)
  await assertSucceeds(user('member').doc('tenantPrompts/p1').get())
  await assertFails(list(user('nephro')))
  await assertFails(list(user('former')))
  await assertFails(list(anon('ghost')))
  await assertFails(getDocs(collection(user('member'), 'tenantPrompts')))
  await assertFails(user('nephro').doc('tenantPrompts/p1').get())
})

test('any active member counts a use, and only by one', async () => {
  await seed((db) => db.doc('tenantPrompts/p1').set(prompt()))
  await assertSucceeds(user('member').doc('tenantPrompts/p1').update({ usageCount: 1 }))
  await assertFails(user('member').doc('tenantPrompts/p1').update({ usageCount: 5 }))
  await assertFails(user('nephro').doc('tenantPrompts/p1').update({ usageCount: 2 }))
})

test('department content revisions increment exactly once and metadata edits do not', async () => {
  const ref = user('builder').doc('tenantPrompts/versioned')
  await assertSucceeds(ref.set(prompt({ version: 1 })))
  await assertSucceeds(ref.update({ category: 'safety', version: 1, updatedAt: new Date() }))
  await assertFails(ref.update({ prompt: 'Changed without a bump', updatedAt: new Date() }))
  await assertSucceeds(ref.update({ prompt: 'Changed', version: 2, updatedAt: new Date() }))
  await assertFails(ref.update({ languagePolicy: 'follow-template', version: 2, updatedAt: new Date() }))
  await assertSucceeds(ref.update({ languagePolicy: 'follow-template', version: 3, updatedAt: new Date() }))
})

test('legacy department templates keep working through the rollout bridge', async () => {
  const ref = user('builder').doc('tenantPrompts/legacy-version')
  await assertSucceeds(ref.set(prompt()))
  await assertSucceeds(ref.update({ prompt: 'Old client edit', updatedAt: new Date() }))
  await assertSucceeds(ref.update({ prompt: 'Version-aware edit', version: 2, updatedAt: new Date() }))
  await assertFails(ref.update({ prompt: 'Old client after backfill', updatedAt: new Date() }))
})

test('public shared prompts cannot smuggle a tenantId', async () => {
  const { tenantId: _tenant, ...publicPrompt } = prompt({ authorId: 'builder', isPublic: true })
  await assertSucceeds(user('builder').doc('sharedPrompts/s1').set(publicPrompt))
  await assertFails(user('builder').doc('sharedPrompts/s2').set(prompt({ authorId: 'builder' })))
})

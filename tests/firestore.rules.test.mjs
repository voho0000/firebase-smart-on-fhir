// Firestore security-rules tests (run against the Firestore emulator).
//   npm run test:rules   (from the firebase repo root)
// which is: firebase emulators:exec --only firestore "node --test tests/"
//
// These lock in the project's Firestore security boundaries — most importantly
// that the per-user daily quota doc is READ-ONLY to the client (the Cloud
// Functions Admin SDK is the sole writer), keeping quota metering server-side.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test, { before, after, beforeEach } from 'node:test'
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing'
import { doc, getDoc, setDoc, deleteDoc, updateDoc } from 'firebase/firestore'

const here = dirname(fileURLToPath(import.meta.url))
const rules = readFileSync(join(here, '..', 'firestore.rules'), 'utf8')
const TODAY = '2026-06-30'

let testEnv

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-mediprisma',
    firestore: { rules },
  })
})
after(async () => { await testEnv?.cleanup() })
beforeEach(async () => { await testEnv.clearFirestore() })

// A normal signed-in user: default sign_in_provider is non-anonymous => isRealUser().
const real = (uid) => testEnv.authenticatedContext(uid).firestore()
// A free-tier anonymous visitor.
const anon = (uid) => testEnv.authenticatedContext(uid, {
  firebase: { sign_in_provider: 'anonymous' },
}).firestore()
const unauth = () => testEnv.unauthenticatedContext().firestore()
// Seed data bypassing rules (simulates the server / Admin SDK writer).
const seed = (fn) => testEnv.withSecurityRulesDisabled((c) => fn(c.firestore()))

// ---------------------------------------------------------------- F1: quota doc
test('F1: signed-in user CANNOT write own usage/quota doc', async () => {
  await assertFails(setDoc(doc(real('alice'), 'users/alice/usage', TODAY), { count: 0 }))
})

test('F1: anonymous user CANNOT write own usage/quota doc', async () => {
  await assertFails(setDoc(doc(anon('anon1'), 'users/anon1/usage', TODAY), { count: 0 }))
})

test('F1: user CAN read own usage doc (quota display still works)', async () => {
  await seed((db) => setDoc(doc(db, 'users/alice/usage', TODAY), { count: 5 }))
  await assertSucceeds(getDoc(doc(real('alice'), 'users/alice/usage', TODAY)))
})

test('F1: user CANNOT read another user usage doc', async () => {
  await assertFails(getDoc(doc(real('alice'), 'users/bob/usage', TODAY)))
})

// ------------------------------------------------------------- user isolation
test('user can read/write own chats but not another user data', async () => {
  await assertSucceeds(setDoc(doc(real('alice'), 'users/alice/chats/c1'), { title: 'x' }))
  await assertFails(setDoc(doc(real('alice'), 'users/bob/chats/c1'), { title: 'x' }))
  await assertFails(getDoc(doc(real('alice'), 'users/bob/chats/c1')))
})

// --------------------------------------------------------------- sharedPrompts
test('sharedPrompts: world-readable (even unauthenticated)', async () => {
  await seed((db) => setDoc(doc(db, 'sharedPrompts/p1'), { authorId: 'alice', usageCount: 0, prompt: 'hi' }))
  await assertSucceeds(getDoc(doc(unauth(), 'sharedPrompts/p1')))
})

test('sharedPrompts: real user can create with own authorId and usageCount 0', async () => {
  await assertSucceeds(setDoc(doc(real('alice'), 'sharedPrompts/p1'), { authorId: 'alice', usageCount: 0, prompt: 'hi' }))
})

test('sharedPrompts: anonymous user CANNOT create', async () => {
  await assertFails(setDoc(doc(anon('anon1'), 'sharedPrompts/p1'), { authorId: 'anon1', usageCount: 0, prompt: 'hi' }))
})

test('sharedPrompts: cannot spoof authorId on create', async () => {
  await assertFails(setDoc(doc(real('alice'), 'sharedPrompts/p1'), { authorId: 'bob', usageCount: 0, prompt: 'hi' }))
})

test('sharedPrompts: usageCount must start at 0', async () => {
  await assertFails(setDoc(doc(real('alice'), 'sharedPrompts/p1'), { authorId: 'alice', usageCount: 7, prompt: 'hi' }))
})

test('sharedPrompts: any real user may increment usageCount by exactly 1', async () => {
  await seed((db) => setDoc(doc(db, 'sharedPrompts/p1'), { authorId: 'alice', usageCount: 0, prompt: 'hi' }))
  await assertSucceeds(updateDoc(doc(real('bob'), 'sharedPrompts/p1'), { usageCount: 1 }))
})

test('sharedPrompts: cannot reset or inflate usageCount by != +1', async () => {
  await seed((db) => setDoc(doc(db, 'sharedPrompts/p1'), { authorId: 'alice', usageCount: 5, prompt: 'hi' }))
  await assertFails(updateDoc(doc(real('bob'), 'sharedPrompts/p1'), { usageCount: 0 }))
  await assertFails(updateDoc(doc(real('bob'), 'sharedPrompts/p1'), { usageCount: 99 }))
})

test('sharedPrompts: only the author can delete', async () => {
  await seed((db) => setDoc(doc(db, 'sharedPrompts/p1'), { authorId: 'alice', usageCount: 0, prompt: 'hi' }))
  await assertFails(deleteDoc(doc(real('bob'), 'sharedPrompts/p1')))
  await assertSucceeds(deleteDoc(doc(real('alice'), 'sharedPrompts/p1')))
})

// ----------------------------------------------------------- feedbackRateLimits
test('feedbackRateLimits: client cannot read or write (admin-only bucket)', async () => {
  await assertFails(getDoc(doc(real('alice'), 'feedbackRateLimits/x')))
  await assertFails(setDoc(doc(real('alice'), 'feedbackRateLimits/x'), { n: 1 }))
})

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
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  deleteDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore'

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

// A normal password user. Feature requests require an account email so the
// administrator can privately identify abusive submissions.
const real = (uid) => testEnv.authenticatedContext(uid, {
  email: `${uid}@example.com`,
  email_verified: true,
  firebase: { sign_in_provider: 'password' },
}).firestore()
// A free-tier anonymous visitor.
const anon = (uid) => testEnv.authenticatedContext(uid, {
  firebase: { sign_in_provider: 'anonymous' },
}).firestore()
const unauth = () => testEnv.unauthenticatedContext().firestore()
const featureAdmin = () => testEnv.authenticatedContext('feature-admin', {
  email: 'voho0000@gmail.com',
  email_verified: true,
  firebase: { sign_in_provider: 'password' },
}).firestore()
const unverifiedFeatureAdmin = () => testEnv.authenticatedContext('feature-admin-unverified', {
  email: 'voho0000@gmail.com',
  email_verified: false,
  firebase: { sign_in_provider: 'password' },
}).firestore()
// Seed data bypassing rules (simulates the server / Admin SDK writer).
const seed = (fn) => testEnv.withSecurityRulesDisabled((c) => fn(c.firestore()))

const featureRequestData = (overrides = {}) => ({
  title: 'A useful feature',
  description: '',
  category: 'feature',
  status: 'evaluating',
  displayAuthor: false,
  authorName: '',
  officialNote: '',
  visibility: 'visible',
  hiddenReason: '',
  hiddenBy: '',
  voteCount: 0,
  createdAt: serverTimestamp(),
  updatedAt: serverTimestamp(),
  ...overrides,
})

async function createFeatureRequestAs(db, requestId, authorId, authorEmail = `${authorId}@example.com`) {
  const batch = writeBatch(db)
  batch.set(doc(db, 'featureRequests', requestId), featureRequestData())
  batch.set(doc(db, 'featureRequestOwners', requestId), {
    authorId,
    authorEmail,
    createdAt: serverTimestamp(),
  })
  await batch.commit()
}

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

// ---------------------------------------------------------- feature requests
test('featureRequests: visible requests are public, hidden requests are not', async () => {
  await seed(async (db) => {
    await setDoc(doc(db, 'featureRequests/visible'), featureRequestData())
    await setDoc(doc(db, 'featureRequests/hidden'), featureRequestData({
      visibility: 'hidden', hiddenReason: 'moderated', hiddenBy: 'admin',
    }))
  })

  await assertSucceeds(getDoc(doc(unauth(), 'featureRequests/visible')))
  await assertFails(getDoc(doc(unauth(), 'featureRequests/hidden')))
  await assertSucceeds(getDocs(query(
    collection(unauth(), 'featureRequests'),
    where('visibility', '==', 'visible'),
  )))
  await assertFails(getDocs(collection(unauth(), 'featureRequests')))
})

test('featureRequests: real user creates a request and private owner record atomically', async () => {
  await assertSucceeds(createFeatureRequestAs(real('alice'), 'r1', 'alice'))
  await assertSucceeds(getDoc(doc(unauth(), 'featureRequests/r1')))
  await assertSucceeds(getDoc(doc(real('alice'), 'featureRequestOwners/r1')))
  await assertFails(getDoc(doc(real('bob'), 'featureRequestOwners/r1')))
})

test('featureRequests: anonymous users and spoofed owner emails cannot create', async () => {
  await assertFails(createFeatureRequestAs(anon('anon1'), 'r1', 'anon1'))
  await assertFails(createFeatureRequestAs(real('alice'), 'r2', 'alice', 'someone@example.com'))
})

test('featureRequests: author can edit promptly, another user cannot', async () => {
  await createFeatureRequestAs(real('alice'), 'r1', 'alice')
  await assertSucceeds(updateDoc(doc(real('alice'), 'featureRequests/r1'), {
    title: 'A corrected title',
    updatedAt: serverTimestamp(),
  }))
  await assertFails(updateDoc(doc(real('bob'), 'featureRequests/r1'), {
    title: 'Spoofed edit',
    updatedAt: serverTimestamp(),
  }))
})

test('featureRequests: editing is locked after 30 minutes', async () => {
  const oldDate = new Date(Date.now() - 31 * 60 * 1000)
  await seed(async (db) => {
    await setDoc(doc(db, 'featureRequests/r1'), featureRequestData({
      createdAt: oldDate,
      updatedAt: oldDate,
    }))
    await setDoc(doc(db, 'featureRequestOwners/r1'), {
      authorId: 'alice', authorEmail: 'alice@example.com', createdAt: oldDate,
    })
  })
  await assertFails(updateDoc(doc(real('alice'), 'featureRequests/r1'), {
    title: 'Too late',
    updatedAt: serverTimestamp(),
  }))
})

test('featureRequests: author withdrawal hides instead of deleting', async () => {
  await createFeatureRequestAs(real('alice'), 'r1', 'alice')
  await assertSucceeds(updateDoc(doc(real('alice'), 'featureRequests/r1'), {
    visibility: 'hidden',
    hiddenReason: 'withdrawn',
    hiddenBy: 'author',
    updatedAt: serverTimestamp(),
  }))
  await assertFails(deleteDoc(doc(real('alice'), 'featureRequests/r1')))
  await assertFails(getDoc(doc(unauth(), 'featureRequests/r1')))
  await assertSucceeds(getDoc(doc(real('alice'), 'featureRequests/r1')))
})

test('featureRequests: vote count changes only with the users private vote record', async () => {
  await createFeatureRequestAs(real('alice'), 'r1', 'alice')
  const bob = real('bob')
  const addVote = writeBatch(bob)
  addVote.set(doc(bob, 'featureRequestVotes/bob/requests/r1'), {
    requestId: 'r1', userId: 'bob', createdAt: serverTimestamp(),
  })
  addVote.update(doc(bob, 'featureRequests/r1'), { voteCount: 1 })
  await assertSucceeds(addVote.commit())

  await assertFails(updateDoc(doc(real('carol'), 'featureRequests/r1'), { voteCount: 99 }))

  const removeVote = writeBatch(bob)
  removeVote.delete(doc(bob, 'featureRequestVotes/bob/requests/r1'))
  removeVote.update(doc(bob, 'featureRequests/r1'), { voteCount: 0 })
  await assertSucceeds(removeVote.commit())
})

test('featureRequests: anonymous users cannot vote', async () => {
  await createFeatureRequestAs(real('alice'), 'r1', 'alice')
  const visitor = anon('anon1')
  const batch = writeBatch(visitor)
  batch.set(doc(visitor, 'featureRequestVotes/anon1/requests/r1'), {
    requestId: 'r1', userId: 'anon1', createdAt: serverTimestamp(),
  })
  batch.update(doc(visitor, 'featureRequests/r1'), { voteCount: 1 })
  await assertFails(batch.commit())
})

test('featureRequests: only the verified administrator email can manage status and visibility', async () => {
  await createFeatureRequestAs(real('alice'), 'r1', 'alice')
  await assertSucceeds(updateDoc(doc(featureAdmin(), 'featureRequests/r1'), {
    status: 'planned',
    officialNote: 'Scheduled for the next release.',
    updatedAt: serverTimestamp(),
  }))
  await assertFails(updateDoc(doc(unverifiedFeatureAdmin(), 'featureRequests/r1'), {
    status: 'completed',
    updatedAt: serverTimestamp(),
  }))
  await assertFails(updateDoc(doc(real('bob'), 'featureRequests/r1'), {
    status: 'completed',
    updatedAt: serverTimestamp(),
  }))
  await assertSucceeds(updateDoc(doc(featureAdmin(), 'featureRequests/r1'), {
    visibility: 'hidden',
    hiddenReason: 'moderated',
    hiddenBy: 'admin',
    updatedAt: serverTimestamp(),
  }))
})

test('featureRequests: administrator can identify submitters without exposing them publicly', async () => {
  await createFeatureRequestAs(real('alice'), 'r1', 'alice')
  await assertSucceeds(getDocs(collection(featureAdmin(), 'featureRequestOwners')))
  await assertFails(getDocs(collection(unauth(), 'featureRequestOwners')))
})

// ----------------------------------------------------------- feedbackRateLimits
test('feedbackRateLimits: client cannot read or write (admin-only bucket)', async () => {
  await assertFails(getDoc(doc(real('alice'), 'feedbackRateLimits/x')))
  await assertFails(setDoc(doc(real('alice'), 'feedbackRateLimits/x'), { n: 1 }))
})

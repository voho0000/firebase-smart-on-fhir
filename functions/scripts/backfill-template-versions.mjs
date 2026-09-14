import { initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

const value = (name) => process.argv.find(argument => argument.startsWith(`--${name}=`))?.slice(name.length + 3)
const apply = process.argv.includes('--apply')
const projectId = value('project') || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT
const databaseId = value('database') || 'mediprisma'
const confirmation = value('confirm-project')

if (!projectId) throw new Error('Set --project=<firebase-project-id> so the target is explicit.')
if (apply && confirmation !== projectId) {
  throw new Error(`Apply requires --confirm-project=${projectId}.`)
}

const app = initializeApp({ projectId })
const db = getFirestore(app, databaseId)
const collections = ['sharedPrompts', 'tenantPrompts']
const missingByCollection = new Map()

for (const collectionName of collections) {
  const snapshot = await db.collection(collectionName).get()
  const missing = snapshot.docs.filter(record => !record.data().hasOwnProperty('version'))
  missingByCollection.set(collectionName, missing)
  console.log(`${collectionName}: ${missing.length} of ${snapshot.size} templates need V1.`)
}

console.log(`Target: project=${projectId}, database=${databaseId}.`)
if (!apply) {
  console.log('Dry run only. Re-run with --apply and the matching --confirm-project value to write V1.')
  process.exit(0)
}

let updated = 0
for (const missing of missingByCollection.values()) {
  for (let start = 0; start < missing.length; start += 450) {
    const batch = db.batch()
    for (const record of missing.slice(start, start + 450)) batch.update(record.ref, { version: 1 })
    await batch.commit()
    updated += Math.min(450, missing.length - start)
  }
}
console.log(`Updated ${updated} templates to V1; content and timestamps were not changed.`)

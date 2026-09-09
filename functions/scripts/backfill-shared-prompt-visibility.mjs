import { initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

const apply = process.argv.includes('--apply')
const app = initializeApp()
const db = getFirestore(app, 'mediprisma')
const snapshot = await db.collection('sharedPrompts').get()
const missing = snapshot.docs.filter((record) => typeof record.get('isPublic') !== 'boolean')

console.log(`Found ${missing.length} shared prompts without isPublic.`)
if (!apply) {
  console.log('Dry run only. Re-run with --apply to mark these existing prompts public.')
  process.exit(0)
}

for (let start = 0; start < missing.length; start += 450) {
  const batch = db.batch()
  for (const record of missing.slice(start, start + 450)) batch.update(record.ref, { isPublic: true })
  await batch.commit()
}

console.log(`Updated ${missing.length} shared prompts.`)

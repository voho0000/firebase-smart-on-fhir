// Admin tool for 檢驗資料問題回報 (Firestore `labDataReports`).
//
// Retention promise (app PRIVACY_POLICY.md §2.10): a report is deleted as soon
// as its problem is handled, and kept 90 days at most. `resolve` is the
// "handled" step and deletes the report outright; the Firestore TTL on
// `expireAt` only catches reports nobody got to.
//
//   npm run lab-reports -- list    --project=<id> [--limit=50]
//   npm run lab-reports -- show    --project=<id> <reportId> [--out=<file>]
//   npm run lab-reports -- resolve --project=<id> <reportId>...
//   npm run lab-reports -- resolve --project=<id> <reportId>... --apply --confirm-project=<id>
//
// Clients cannot read this collection (firestore.rules), so this needs Admin
// credentials (gcloud application-default login). FIRESTORE_EMULATOR_HOST
// points it at the emulator.
import { writeFileSync } from 'node:fs'
import { initializeApp } from 'firebase-admin/app'
import { Timestamp, getFirestore } from 'firebase-admin/firestore'

const COLLECTION = 'labDataReports'
// Rows are stored in 250-row chunk documents under each report.
const ROWS = 'labDataReportRows'

const value = (name) => process.argv.find(argument => argument.startsWith(`--${name}=`))?.slice(name.length + 3)
const positional = process.argv.slice(2).filter(argument => !argument.startsWith('--'))
const [command, ...reportIds] = positional
const apply = process.argv.includes('--apply')
const projectId = value('project') || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT
const databaseId = value('database') || 'mediprisma'
const confirmation = value('confirm-project')

if (!projectId) throw new Error('Set --project=<firebase-project-id> so the target is explicit.')
if (!['list', 'show', 'resolve'].includes(command)) {
  throw new Error('Usage: lab-data-reports.mjs <list|show|resolve> --project=<id> [reportId...]')
}
if (command !== 'list' && reportIds.length === 0) throw new Error(`${command} needs at least one report id.`)
if (apply && confirmation !== projectId) throw new Error(`Apply requires --confirm-project=${projectId}.`)

const app = initializeApp({ projectId })
const db = getFirestore(app, databaseId)

const toPlain = (input) => {
  if (input instanceof Timestamp) return input.toDate().toISOString()
  if (Array.isArray(input)) return input.map(toPlain)
  if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, toPlain(item)]))
  return input
}
const taipei = (timestamp) => timestamp instanceof Timestamp
  ? timestamp.toDate().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(0, 16)
  : '—'
const daysLeft = (timestamp) => timestamp instanceof Timestamp
  ? Math.max(0, Math.ceil((timestamp.toMillis() - Date.now()) / 86_400_000))
  : '—'
const summary = (id, data) => [
  id,
  taipei(data.createdAt),
  `${daysLeft(data.expireAt)}d left`,
  (data.scope?.flaggedCategories?.length ? `flagged:${data.scope.flaggedCategories.join(',')}` : 'flagged:-'),
  data.problemType ?? '?',
  `${data.rowCount ?? data.rows?.length ?? 0} rows${data.includesValues ? '' : ' (no values)'}`,
  `${data.context?.dataSource ?? '?'}/${data.context?.site ?? '?'}`,
  data.description ? JSON.stringify(String(data.description).slice(0, 60)) : '',
].join('  ')

console.log(`Target: project=${projectId}, database=${databaseId}.`)

if (command === 'list') {
  const limit = Number(value('limit') || 50)
  const snapshot = await db.collection(COLLECTION).orderBy('createdAt', 'desc').limit(limit).get()
  console.log(`${snapshot.size} report(s), newest first:`)
  for (const record of snapshot.docs) console.log(summary(record.id, record.data()))
  process.exit(0)
}

if (command === 'show') {
  const out = value('out')
  const reports = []
  for (const id of reportIds) {
    const record = await db.collection(COLLECTION).doc(id).get()
    if (!record.exists) throw new Error(`${id}: not found (already resolved, or expired).`)
    const chunks = await record.ref.collection(ROWS).orderBy('chunk').get()
    const rows = chunks.docs.flatMap((chunk) => chunk.get('rows') ?? [])
    reports.push({ id, ...toPlain(record.data()), rows: toPlain(rows) })
  }
  const text = JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2)
  if (out) {
    // Owner-only: the rows may carry lab values.
    writeFileSync(out, `${text}\n`, { mode: 0o600 })
    console.log(`Wrote ${reports.length} report(s) to ${out}.`)
  } else {
    console.log(text)
  }
  process.exit(0)
}

// resolve — the problem is handled, so the report is deleted.
const found = []
for (const id of reportIds) {
  const record = await db.collection(COLLECTION).doc(id).get()
  if (!record.exists) {
    console.log(`${id}: not found (already resolved, or expired).`)
    continue
  }
  found.push(record)
  console.log(`${apply ? 'Deleting' : 'Would delete'}: ${summary(record.id, record.data())}`)
}
if (!apply) {
  console.log('Dry run only. Re-run with --apply and the matching --confirm-project value to delete.')
  process.exit(0)
}
// recursiveDelete also removes the row chunks under each report.
for (const record of found) await db.recursiveDelete(record.ref)
console.log(`Deleted ${found.length} resolved report(s).`)

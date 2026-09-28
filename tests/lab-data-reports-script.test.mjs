import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, deleteApp } = require('firebase-admin/app')
const { getFirestore, Timestamp } = require('firebase-admin/firestore')

test('lab-data report admin tool lists, shows, and deletes a handled report only on --apply', async () => {
  const projectId = 'demo-lab-data-reports-script'
  process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080'
  const app = initializeApp({ projectId }, 'lab-data-reports-script-test')
  const db = getFirestore(app, 'mediprisma')
  const now = Date.now()
  const report = async (id, minutesAgo) => {
    await db.doc(`labDataReports/${id}`).set({
      reportId: id,
      problemType: 'wrong-panel',
      description: 'C3 在尿液',
      includesValues: true,
      scope: { flaggedCategories: ['urine'], categories: [{ categoryId: 'urine', rows: 2 }] },
      context: { dataSource: 'medcloud', site: 'vghtpe' },
      rowCount: 2,
      rowChunks: 2,
      createdAt: Timestamp.fromMillis(now - minutesAgo * 60_000),
      expireAt: Timestamp.fromMillis(now + 90 * 86_400_000),
    })
    // Two chunks, stored out of order on purpose.
    await db.doc(`labDataReports/${id}/labDataReportRows/001`).set({ chunk: 1, rows: [{ ref: 2, value: { kind: 'quantity', value: 99, magnitude: 1, decimals: 0 } }] })
    await db.doc(`labDataReports/${id}/labDataReportRows/000`).set({ chunk: 0, rows: [{ ref: 1, value: { kind: 'quantity', value: 98, magnitude: 1, decimals: 0 } }] })
  }
  await report('LDR-20260927-AAAAAAAA', 10)
  await report('LDR-20260927-BBBBBBBB', 5)

  const run = (...args) => spawnSync(process.execPath, ['functions/scripts/lab-data-reports.mjs', ...args, `--project=${projectId}`], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', env: process.env,
  })
  try {
    const list = run('list')
    assert.equal(list.status, 0, list.stderr)
    assert.ok(list.stdout.indexOf('LDR-20260927-BBBBBBBB') < list.stdout.indexOf('LDR-20260927-AAAAAAAA'), 'newest first')
    assert.match(list.stdout, /flagged:urine {2}wrong-panel {2}2 rows {2}medcloud\/vghtpe/)

    const out = join(mkdtempSync(join(tmpdir(), 'lab-report-')), 'report.json')
    assert.equal(run('show', 'LDR-20260927-AAAAAAAA', `--out=${out}`).status, 0)
    const shown = JSON.parse(readFileSync(out, 'utf8'))
    assert.deepEqual(shown.rows.map((row) => row.value.value), [98, 99])
    assert.match(shown.createdAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(statSync(out).mode & 0o777, 0o600)

    const dry = run('resolve', 'LDR-20260927-AAAAAAAA')
    assert.equal(dry.status, 0)
    assert.match(dry.stdout, /Would delete/)
    assert.ok((await db.doc('labDataReports/LDR-20260927-AAAAAAAA').get()).exists)

    assert.notEqual(run('resolve', 'LDR-20260927-AAAAAAAA', '--apply').status, 0)
    const applied = run('resolve', 'LDR-20260927-AAAAAAAA', '--apply', `--confirm-project=${projectId}`)
    assert.equal(applied.status, 0, applied.stderr)
    assert.match(applied.stdout, /Deleted 1 resolved report/)
    assert.equal((await db.doc('labDataReports/LDR-20260927-AAAAAAAA').get()).exists, false)
    assert.equal((await db.collection('labDataReports/LDR-20260927-AAAAAAAA/labDataReportRows').get()).size, 0)
    assert.ok((await db.doc('labDataReports/LDR-20260927-BBBBBBBB').get()).exists)

    assert.match(run('resolve', 'LDR-20260927-AAAAAAAA').stdout, /not found/)
    assert.notEqual(run('show', 'LDR-20260927-AAAAAAAA').status, 0)
  } finally { await deleteApp(app) }
})

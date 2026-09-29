// submitLabDataReport — stores a clinician-initiated, de-identified lab-data
// problem report (PRIVACY_POLICY.md §2.10 in the app repo).
//
// This is the one exception to the app's "no clinical data server-side"
// policy, approved 2026-09-27: user-initiated, disclosed, laboratory
// Observations only, no patient identifiers or absolute dates. The Function
// is the gate: it re-validates the contract, re-runs the identifier scan,
// and is the only writer of `labDataReports` (clients cannot read or write
// it — see firestore.rules). A report is deleted once its problem is handled
// (functions/scripts/lab-data-reports.mjs resolve); the Firestore TTL policy
// on `expireAt` (90 days) is only the ceiling for reports nobody got to.
import type {Request, Response} from "express";
import {createHash, randomBytes} from "crypto";
import {getApps, initializeApp} from "firebase-admin/app";
import {
  FieldValue,
  Timestamp,
  getFirestore,
} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {verifyClientKey, verifyFirebaseIdToken} from "../../middleware/auth";
import {verifyAppCheck} from "../../middleware/appCheck";
import {LabDataReportError, normalizeLabDataReport} from "./schema";
import {sendLabReportNotice} from "./notify";

const DATABASE_ID = "mediprisma";
export const REPORTS_COLLECTION = "labDataReports";
// Rows live in chunk documents under the report: a whole-patient report
// (~1 MB at 1,400 rows) would not fit Firestore's 1 MiB document limit.
// Chunks are cut by SIZE, not a fixed row count — a row can legitimately
// reach ~12 KB (10 codings × 3 × 200 chars …), so 250 such rows would be
// ~3 MB and fail the whole write.
export const ROWS_SUBCOLLECTION = "labDataReportRows";
export const MAX_ROWS_PER_CHUNK = 250;
export const MAX_CHUNK_BYTES = 800 * 1024;

/**
 * Firestore's storage size of a value (the rules the 1 MiB limit is
 * measured with): string = UTF-8 bytes + 1, number 8, boolean/null 1, map
 * field = name bytes + 1 + value, array/map = the sum of their contents.
 * @param {unknown} value - A JSON-like value.
 * @return {number} Estimated bytes.
 */
export const firestoreSize = (value: unknown): number => {
  if (value === null || value === undefined || typeof value === "boolean") {
    return 1;
  }
  if (typeof value === "number") return 8;
  if (typeof value === "string") return Buffer.byteLength(value) + 1;
  if (Array.isArray(value)) {
    return value.reduce((sum: number, item) => sum + firestoreSize(item), 0);
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).reduce(
      (sum, [key, item]) =>
        sum + Buffer.byteLength(key) + 1 + firestoreSize(item),
      0,
    );
  }
  return 8;
};

/**
 * Split rows into chunks that each stay well under the document limit.
 * @param {Array<unknown>} rows - Normalised rows.
 * @return {Array<Array<unknown>>} Chunks, in order.
 */
export const chunkRows = (rows: unknown[]): unknown[][] => {
  const chunks: unknown[][] = [];
  let current: unknown[] = [];
  let size = 0;
  for (const row of rows) {
    const bytes = firestoreSize(row);
    if (
      current.length > 0 &&
      (size + bytes > MAX_CHUNK_BYTES || current.length >= MAX_ROWS_PER_CHUNK)
    ) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(row);
    size += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
};
export const RATE_LIMIT_COLLECTION = "labDataReportRateLimits";
// One document per (reporter, payload fingerprint): a resend after a client
// timeout returns the first report instead of storing it twice.
export const SUBMISSION_KEYS_COLLECTION = "labDataReportKeys";
const SUBMISSION_KEY_TTL_MS = 24 * 60 * 60 * 1000;
export const RETENTION_DAYS = 90;
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

const HOUR_MS = 60 * 60 * 1000;
// A clinician reporting several panels of one patient stays well inside
// these; a script minting anonymous sessions hits the per-IP bucket.
const UID_LIMIT = Number(process.env.LAB_REPORT_UID_LIMIT ?? "10");
const IP_LIMIT = Number(process.env.LAB_REPORT_IP_LIMIT ?? "30");

const ensureAdminApp = () => {
  if (getApps().length === 0) {
    initializeApp();
  }
};

// Buckets are keyed by a salted digest; neither a uid nor an IP is stored in
// the rate-limit collection.
const bucketKey = (kind: "uid" | "ip", value: string): string =>
  createHash("sha256")
    .update(
      (process.env.RATE_LIMIT_SALT ?? "mediprisma-lab-data-report") +
      `${kind}:${value}`,
    )
    .digest("hex")
    .slice(0, 40);

/**
 * Consume one unit from a fixed-window bucket. Fails OPEN on a Firestore
 * error, like the feedback limiter: the write that follows would surface a
 * real outage anyway.
 * @param {string} key - Bucket document id.
 * @param {number} max - Allowed requests per window.
 * @return {Promise<boolean>} true when the caller is over the limit.
 */
const isOverLimit = async (key: string, max: number): Promise<boolean> => {
  try {
    const db = getFirestore(DATABASE_ID);
    const ref = db.collection(RATE_LIMIT_COLLECTION).doc(key);
    return await db.runTransaction(async (tx) => {
      const now = Date.now();
      const data = (await tx.get(ref)).data() as
        | {count?: number; windowStart?: number}
        | undefined;
      const windowStart = data?.windowStart ?? 0;
      const count = data?.count ?? 0;
      if (now - windowStart > HOUR_MS) {
        tx.set(ref, {
          count: 1,
          windowStart: now,
          expireAt: Timestamp.fromMillis(now + HOUR_MS),
        });
        return false;
      }
      if (count >= max) return true;
      tx.set(ref, {count: count + 1}, {merge: true});
      return false;
    });
  } catch (error) {
    logger.error("Lab-data report rate-limit check failed — failing open", {
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
};

const createReportId = (now: Date): string => {
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  return `LDR-${day}-${randomBytes(4).toString("hex").toUpperCase()}`;
};

const bodyBytes = (req: Request): number => {
  const raw = (req as Request & {rawBody?: Buffer}).rawBody;
  if (raw) return raw.length;
  if (typeof req.body === "string") return Buffer.byteLength(req.body);
  return Buffer.byteLength(JSON.stringify(req.body ?? {}));
};

export const handleLabDataReport = async (
  req: Request,
  res: Response,
): Promise<void> => {
  if (req.method !== "POST") {
    res.set("Allow", "POST, OPTIONS");
    res.status(405).json({success: false, error: "Method not allowed"});
    return;
  }
  if (!verifyClientKey(req, res)) return;
  if (!(await verifyAppCheck(req, res))) return;
  const user = await verifyFirebaseIdToken(req, res);
  if (!user) return;

  if (!req.is("application/json")) {
    res.status(415).json({success: false, error: "Expected application/json"});
    return;
  }
  if (bodyBytes(req) > MAX_BODY_BYTES) {
    res.status(413).json({success: false, error: "Payload too large"});
    return;
  }

  ensureAdminApp();
  const ip =
    req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (
    await isOverLimit(bucketKey("uid", user.uid), UID_LIMIT) ||
    await isOverLimit(bucketKey("ip", ip), IP_LIMIT)
  ) {
    res.status(429).json({success: false, error: "Too many requests"});
    return;
  }

  let normalized;
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    normalized = normalizeLabDataReport(body);
  } catch (error) {
    const reason = error instanceof LabDataReportError ?
      error.reason :
      "invalid-json";
    // The reason names a field path, never a submitted value.
    logger.warn("Lab-data report rejected", {reason});
    res.status(400).json({success: false, error: "Invalid report", reason});
    return;
  }

  const db = getFirestore(DATABASE_ID);
  const keyRef = normalized.submissionKey ?
    db.collection(SUBMISSION_KEYS_COLLECTION)
      .doc(bucketKey("uid", `${user.uid}:${normalized.submissionKey}`)) :
    null;
  const existingReportId = async (): Promise<string | undefined> => {
    if (!keyRef) return undefined;
    const existing = await keyRef.get();
    return existing.exists ? existing.get("reportId") as string : undefined;
  };
  const alreadyStored = await existingReportId();
  if (alreadyStored) {
    logger.info("Lab-data report resend — returning the stored report", {
      reportId: alreadyStored,
    });
    res.status(200).json({success: true, reportId: alreadyStored});
    return;
  }

  const now = new Date();
  const expireAt = Timestamp.fromMillis(
    now.getTime() + RETENTION_DAYS * 24 * HOUR_MS,
  );
  const {rows, ...header} = normalized.report;
  const chunks = chunkRows(rows as unknown[]);
  const chunkCount = chunks.length;
  // MediCloud raw rows ride in the same subcollection as their own chunks
  // ("raw-000" …, kind "raw"), so the rules, the TTL and the delete path
  // that cover the report's rows cover them too.
  const rawChunks = chunkRows(normalized.rawRows);
  const document = {
    ...header,
    reporterUid: user.uid,
    reporterIsAnonymous: user.isAnonymous,
    rowCount: normalized.rowCount,
    rowChunks: chunkCount,
    rawRowCount: normalized.rawRows.length,
    rawRowChunks: rawChunks.length,
    serverDroppedStrings: normalized.serverDroppedStrings,
    serverUnknownPanels: normalized.serverUnknownPanels,
    createdAt: FieldValue.serverTimestamp(),
    // The retention ceiling. A report is deleted as soon as its problem is
    // handled (scripts/lab-data-reports.mjs resolve); TTL only catches the
    // ones nobody got to. Chunks carry it too: TTL is per document.
    expireAt,
  };

  // One batch: the report and all its row chunks land together or not at
  // all. create() never overwrites; a random-id collision retries once.
  const write = async (reportId: string) => {
    const reportRef = db.collection(REPORTS_COLLECTION).doc(reportId);
    const batch = db.batch();
    batch.create(reportRef, {...document, reportId});
    if (keyRef) {
      batch.create(keyRef, {
        reportId,
        expireAt: Timestamp.fromMillis(now.getTime() + SUBMISSION_KEY_TTL_MS),
      });
    }
    chunks.forEach((chunkRowsList, chunk) => {
      batch.create(
        reportRef.collection(ROWS_SUBCOLLECTION)
          .doc(String(chunk).padStart(3, "0")),
        {chunk, rows: chunkRowsList, expireAt},
      );
    });
    rawChunks.forEach((chunkRowsList, chunk) => {
      batch.create(
        reportRef.collection(ROWS_SUBCOLLECTION)
          .doc(`raw-${String(chunk).padStart(3, "0")}`),
        {kind: "raw", chunk, rows: chunkRowsList, expireAt},
      );
    });
    await batch.commit();
  };
  let reportId = createReportId(now);
  try {
    await write(reportId);
  } catch (error) {
    if ((error as {code?: number}).code !== 6) throw error; // ALREADY_EXISTS
    // Either a concurrent resend of the same payload won the race, or the
    // random report id collided.
    const raced = await existingReportId();
    if (raced) {
      res.status(200).json({success: true, reportId: raced});
      return;
    }
    reportId = createReportId(now);
    await write(reportId);
  }

  logger.info("Lab-data report stored", {
    reportId,
    rowCount: normalized.rowCount,
    rawRowCount: normalized.rawRows.length,
    serverDroppedStrings: normalized.serverDroppedStrings,
    problemType: normalized.report.problemType,
  });

  // Awaited (a v2 Function may be frozen once it responds) but never fatal.
  const scope = normalized.report.scope as {
    flaggedCategories: string[];
    categories: Array<{categoryId: string; rows: number}>;
  };
  const context = normalized.report.context as {
    dataSource: string; site: string;
  };
  await sendLabReportNotice({
    reportId,
    problemType: String(normalized.report.problemType),
    flaggedCategories: scope.flaggedCategories,
    categories: scope.categories,
    rowCount: normalized.rowCount,
    rawRowCount: normalized.rawRows.length,
    includesValues: normalized.report.includesValues === true,
    dataSource: context.dataSource,
    site: context.site,
    hasDescription: String(normalized.report.description ?? "").length > 0,
  });

  res.status(200).json({success: true, reportId});
};

// Server-side daily quota (audit A6).
//
// The app has always shown a 200/day quota for proxy users, but enforcement
// only existed client-side (and the check was never even called). This makes
// the function the source of truth: one Firestore transaction per proxied
// request against the same users/{uid}/usage/{YYYY-MM-DD} doc the app reads
// for its quota display, in the named database "mediprisma".
import type {Response} from "express";
import {getApps, initializeApp} from "firebase-admin/app";
import {getFirestore, FieldValue} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";

// Keep in sync with the app's QUOTA_CONFIG.DAILY_LIMIT
const DAILY_LIMIT = Number(process.env.QUOTA_DAILY_LIMIT ?? "200");
const DATABASE_ID = "mediprisma";

const ensureAdminApp = () => {
  if (getApps().length === 0) {
    initializeApp();
  }
};

// Same key format as the app's usage-tracker (toISOString date part)
const todayString = (): string => new Date().toISOString().split("T")[0];

/**
 * Atomically consume one unit of today's quota for the user.
 * Returns false (and responds 429) when the daily limit is reached.
 * Firestore being unavailable fails open — availability of the clinical
 * tool wins over strict metering; the failure is logged for follow-up.
 * @param {string} uid - Authenticated user id.
 * @param {Response} res - Response (written on quota exhaustion).
 * @return {Promise<boolean>} Whether the request may proceed.
 */
export const checkAndConsumeQuota = async (
  uid: string,
  res: Response,
): Promise<boolean> => {
  ensureAdminApp();
  const db = getFirestore(DATABASE_ID);
  const today = todayString();
  const ref = db
    .collection("users").doc(uid)
    .collection("usage").doc(today);

  try {
    const allowed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const count = (snap.data()?.count as number | undefined) ?? 0;
      if (count >= DAILY_LIMIT) {
        return false;
      }
      tx.set(
        ref,
        {
          count: count + 1,
          date: today,
          lastUpdated: FieldValue.serverTimestamp(),
        },
        {merge: true},
      );
      return true;
    });

    if (!allowed) {
      logger.warn("Daily quota exceeded", {uid, limit: DAILY_LIMIT});
      res.status(429).json({
        error: `Daily quota exceeded (${DAILY_LIMIT}/day). ` +
          "Add your own API key in Settings for unlimited use.",
      });
    }
    return allowed;
  } catch (error) {
    logger.error("Quota check failed — failing open", {
      uid,
      message: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
};

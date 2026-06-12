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

export type QuotaService = "chat" | "perplexity" | "whisper";

// Per-service daily limits, env-tunable without a code change.
// chat (GPT/Gemini) stays in sync with the app's QUOTA_CONFIG.DAILY_LIMIT;
// perplexity and whisper are costlier per call and get smaller buckets.
const LIMITS: Record<QuotaService, number> = {
  chat: Number(process.env.QUOTA_DAILY_LIMIT ?? "200"),
  perplexity: Number(process.env.QUOTA_DAILY_LIMIT_PERPLEXITY ?? "50"),
  whisper: Number(process.env.QUOTA_DAILY_LIMIT_WHISPER ?? "50"),
};

// Field names inside the daily usage doc. "count" is chat — the app's quota
// display reads that exact field, so it must keep its name.
const FIELDS: Record<QuotaService, string> = {
  chat: "count",
  perplexity: "perplexityCount",
  whisper: "whisperCount",
};

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
 * @param {QuotaService} service - Which per-service bucket to charge.
 * @return {Promise<boolean>} Whether the request may proceed.
 */
export const checkAndConsumeQuota = async (
  uid: string,
  res: Response,
  service: QuotaService = "chat",
): Promise<boolean> => {
  ensureAdminApp();
  const db = getFirestore(DATABASE_ID);
  const today = todayString();
  const limit = LIMITS[service];
  const field = FIELDS[service];
  const ref = db
    .collection("users").doc(uid)
    .collection("usage").doc(today);

  try {
    const allowed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const count = (snap.data()?.[field] as number | undefined) ?? 0;
      if (count >= limit) {
        return false;
      }
      tx.set(
        ref,
        {
          [field]: count + 1,
          date: today,
          lastUpdated: FieldValue.serverTimestamp(),
        },
        {merge: true},
      );
      return true;
    });

    if (!allowed) {
      logger.warn("Daily quota exceeded", {uid, service, limit});
      // Wording matters: the released app maps /daily quota exceeded/i to a
      // localized message — keep that prefix
      res.status(429).json({
        error: `Daily quota exceeded — ${service} (${limit}/day). ` +
          "Add your own API key in Settings for unlimited use.",
      });
    }
    return allowed;
  } catch (error) {
    logger.error("Quota check failed — failing open", {
      uid,
      service,
      message: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
};

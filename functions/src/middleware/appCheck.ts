import type {Request, Response} from "express";
import * as logger from "firebase-functions/logger";
import {getApps, initializeApp} from "firebase-admin/app";
import {getAppCheck} from "firebase-admin/app-check";

const ensureAdminApp = () => {
  if (getApps().length === 0) {
    initializeApp();
  }
};

// Enforcement is OFF by default so this can ship before the app is sending
// tokens. Flip APPCHECK_ENFORCE=true (env/secret) once real traffic is observed
// to carry valid tokens (see the log-only warnings below).
// A per-function override (res.locals.appCheckEnforce, set by
// withCorsAndErrorHandling options) wins over the env flag, so the dev-*
// group can enforce before production does — env is shared codebase-wide.
const isEnforced = (res: Response): boolean => {
  const override = res.locals?.appCheckEnforce;
  if (typeof override === "boolean") {
    return override;
  }
  const v = (process.env.APPCHECK_ENFORCE ?? "").toLowerCase();
  return v === "true" || v === "1";
};

/**
 * Verify the Firebase App Check token (anti-abuse: proves the request comes
 * from the genuine app, not a raw script minting throwaway anonymous sessions).
 *
 * Two modes, chosen by APPCHECK_ENFORCE:
 *  - unset/false (default): LOG-ONLY — records whether a valid token was
 *    present but always allows the request, so it is safe to deploy before
 *    the clients are updated.
 *  - true/1: ENFORCE — a missing/invalid token responds 401 and returns false.
 *
 * @param {Request} req - Incoming request (reads the X-Firebase-AppCheck head).
 * @param {Response} res - Response (written only on rejection when enforcing).
 * @return {Promise<boolean>} Whether the request may proceed.
 */
export const verifyAppCheck = async (
  req: Request,
  res: Response,
): Promise<boolean> => {
  const enforce = isEnforced(res);
  const token = req.header("X-Firebase-AppCheck");

  if (!token) {
    if (enforce) {
      res.status(401).json({error: "App Check token missing"});
      return false;
    }
    logger.warn("App Check token missing (log-only)");
    return true;
  }

  try {
    ensureAdminApp();
    await getAppCheck().verifyToken(token);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (enforce) {
      logger.warn("App Check verification failed", {message});
      res.status(401).json({error: "Invalid App Check token"});
      return false;
    }
    logger.warn("App Check verification failed (log-only)", {message});
    return true;
  }
};

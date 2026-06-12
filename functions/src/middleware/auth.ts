import type {Request, Response} from "express";
import * as logger from "firebase-functions/logger";
import {getApps, initializeApp} from "firebase-admin/app";
import {getAuth} from "firebase-admin/auth";
import {getRuntimeConfig} from "../config/runtime";
import {parseList} from "../utils/parser";

const ensureAdminApp = () => {
  if (getApps().length === 0) {
    initializeApp();
  }
};

const getClientKeys = (): string[] =>
  parseList(getRuntimeConfig().proxy?.client_keys ?? process.env.CLIENT_KEYS);

export const verifyClientKey = (req: Request, res: Response): boolean => {
  const clientKeys = getClientKeys();
  if (clientKeys.length === 0) {
    return true;
  }

  const providedKey = req.header("x-proxy-key")?.trim();

  if (!providedKey || !clientKeys.includes(providedKey)) {
    logger.warn("Unauthorized proxy request rejected", {
      hasKey: Boolean(providedKey),
    });
    res.status(401).json({error: "Unauthorized"});
    return false;
  }

  return true;
};

/**
 * Real authentication for the owner-funded LLM proxies (audit A6).
 *
 * x-proxy-key alone is NOT auth — it ships inside the public static bundle,
 * and with CLIENT_KEYS unset verifyClientKey admits everyone (which is how
 * production actually ran: probing the deployed endpoints without any key
 * returned 400 payload errors, never 401). A Firebase ID token proves a
 * signed-in user and gives us a uid to meter quota against.
 *
 * @param {Request} req - Incoming request.
 * @param {Response} res - Response (written on auth failure).
 * @return {Promise<string | null>} The uid, or null after responding 401.
 */
export const verifyFirebaseIdToken = async (
  req: Request,
  res: Response,
): Promise<string | null> => {
  const authHeader = req.header("authorization") ?? "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    res.status(401).json({
      error: "Sign-in required. The built-in quota is available to " +
        "signed-in users; or add your own API key in Settings.",
    });
    return null;
  }

  try {
    ensureAdminApp();
    const decoded = await getAuth().verifyIdToken(match[1]);
    return decoded.uid;
  } catch (error) {
    logger.warn("ID token verification failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    res.status(401).json({
      error: "Invalid or expired session. Please sign in again.",
    });
    return null;
  }
};

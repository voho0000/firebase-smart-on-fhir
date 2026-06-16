import type {Request, Response} from "express";
import {createHash} from "crypto";
import {getApps, initializeApp} from "firebase-admin/app";
import {getFirestore, FieldValue} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {Resend} from "resend";
import {verifyClientKey} from "../../middleware/auth";
import {parseJsonBody} from "../../utils/parser";
import type {FeedbackRequest} from "./types";
import {
  getIssueTypeLabel,
  getSeverityLabel,
  generateEmailHTML,
  generatePlainText,
} from "./utils";

const DATABASE_ID = "mediprisma";
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 5;

const ensureAdminApp = () => {
  if (getApps().length === 0) {
    initializeApp();
  }
};

// Hash the caller IP before storing it — we never persist a raw address.
// The salt keeps the digest non-reversible if the collection ever leaks.
const ipKey = (ip: string): string =>
  createHash("sha256")
    .update((process.env.RATE_LIMIT_SALT ?? "mediprisma-feedback") + ip)
    .digest("hex")
    .slice(0, 32);

/**
 * Durable per-IP feedback rate limit backed by Firestore. The previous
 * in-memory Map reset on every new serverless instance / cold start, so a
 * scripted flood could blow far past the intended 5/hour by spreading across
 * instances. A Firestore counter is shared by all instances. Fails OPEN on any
 * Firestore error — an infra hiccup must never block a real bug report.
 * @param {string} ip - Caller IP (from x-forwarded-for).
 * @return {Promise<boolean>} true when the caller is over the limit.
 */
const isRateLimited = async (ip: string): Promise<boolean> => {
  ensureAdminApp();
  try {
    const db = getFirestore(DATABASE_ID);
    const ref = db.collection("feedbackRateLimits").doc(ipKey(ip));
    return await db.runTransaction(async (tx) => {
      const now = Date.now();
      const data = (await tx.get(ref)).data() as
        | {count?: number; windowStart?: number}
        | undefined;
      const windowStart = data?.windowStart ?? 0;
      const count = data?.count ?? 0;
      // Window elapsed → reset the bucket and allow.
      if (now - windowStart > RATE_LIMIT_WINDOW_MS) {
        tx.set(ref, {
          count: 1,
          windowStart: now,
          // For an optional Firestore TTL policy on `expireAt` to auto-purge.
          expireAt: new Date(now + RATE_LIMIT_WINDOW_MS),
          lastUpdated: FieldValue.serverTimestamp(),
        });
        return false;
      }
      if (count >= RATE_LIMIT_MAX) {
        return true;
      }
      tx.set(
        ref,
        {count: count + 1, lastUpdated: FieldValue.serverTimestamp()},
        {merge: true},
      );
      return false;
    });
  } catch (error) {
    logger.error("Feedback rate-limit check failed — failing open", {
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
};

const MAX_FIELD_LENGTH = 5000;

export const handleFeedback = async (
  req: Request,
  res: Response,
): Promise<void> => {
  if (req.method !== "POST") {
    res.set("Allow", "POST, OPTIONS");
    res.status(405).send("Method not allowed");
    return;
  }

  if (!verifyClientKey(req, res)) {
    return;
  }

  const ip =
    req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (await isRateLimited(ip)) {
    res.status(429).json({error: "Too many requests"});
    return;
  }

  try {
    const payload = parseJsonBody(req);
    const body = payload as unknown as FeedbackRequest;

    const {email, issueType, severity, description, steps, systemInfo} = body;

    if (!email || !issueType || !description) {
      res.status(400).json({error: "Missing required fields"});
      return;
    }

    if (
      String(email).length > 320 ||
      String(description).length > MAX_FIELD_LENGTH ||
      String(steps ?? "").length > MAX_FIELD_LENGTH
    ) {
      res.status(413).json({error: "Payload too large"});
      return;
    }

    const resendApiKey = process.env.RESEND_API_KEY;

    if (!resendApiKey) {
      logger.warn(
        "RESEND_API_KEY not configured — feedback received but no email sent",
        {issueType, severity},
      );

      res.status(200).json({
        success: true,
        emailSent: false,
        message: "Feedback received (email not configured)",
      });
      return;
    }

    const resend = new Resend(resendApiKey);

    const emailContent = generateEmailHTML(
      email,
      issueType,
      severity,
      description,
      steps,
      systemInfo,
    );

    const plainTextContent = generatePlainText(
      email,
      issueType,
      severity,
      description,
      steps,
      systemInfo,
    );

    const issueTypeLabel = getIssueTypeLabel(issueType);
    const severityLabel = getSeverityLabel(severity);

    logger.info("Sending feedback email via Resend...");

    const {data, error} = await resend.emails.send({
      from: "onboarding@resend.dev",
      to: ["voho0000@gmail.com"],
      replyTo: email,
      subject: `[問題回報] ${issueTypeLabel} - ${severityLabel}`,
      html: emailContent,
      text: plainTextContent,
    });

    if (error) {
      // Details stay in server logs; callers get a generic error
      logger.error("Resend SDK error:", error);
      res.status(500).json({error: "Internal server error"});
      return;
    }

    logger.info("Feedback email sent, id:", data?.id);

    res.status(200).json({success: true, emailSent: true});
  } catch (error) {
    logger.error("Feedback handler error:", error);
    res.status(500).json({error: "Internal server error"});
  }
};

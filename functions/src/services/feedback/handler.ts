import type {Request, Response} from "express";
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

// Per-instance rate bucket — not globally exact on serverless, but caps a
// single source's email flood at a handful per hour instead of unlimited
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 5;
const rateBuckets = new Map<string, {count: number; resetAt: number}>();

const isRateLimited = (ip: string): boolean => {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    rateBuckets.set(ip, {count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS});
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT_MAX;
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
  if (isRateLimited(ip)) {
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

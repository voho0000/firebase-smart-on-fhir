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

  try {
    const payload = parseJsonBody(req);
    const body = payload as unknown as FeedbackRequest;

    const {email, issueType, severity, description, steps, systemInfo} = body;

    if (!email || !issueType || !description) {
      res.status(400).json({error: "Missing required fields"});
      return;
    }

    const resendApiKey = process.env.RESEND_API_KEY;

    if (!resendApiKey) {
      logger.warn("RESEND_API_KEY not configured");
      logger.info("Feedback submission (no email sent):", {
        email,
        issueType,
        severity,
        description: description.substring(0, 100) + "...",
      });

      res.status(200).json({
        success: true,
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
      logger.error("Resend SDK error:", error);
      res.status(500).json({
        error: "Internal server error",
        details: error.message,
      });
      return;
    }

    logger.info("Feedback email sent successfully:", data);

    res.status(200).json({success: true});
  } catch (error) {
    logger.error("Feedback handler error:", error);
    const errorMessage =
      error instanceof Error ? error.message : String(error);

    res.status(500).json({
      error: "Internal server error",
      details: errorMessage,
    });
  }
};

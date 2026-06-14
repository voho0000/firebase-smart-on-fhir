import type {Request, Response} from "express";
import * as logger from "firebase-functions/logger";
import {verifyClientKey, verifyFirebaseIdToken} from "../../middleware/auth";
import {checkAndConsumeQuota} from "../../middleware/quota";
import {parseJsonBody} from "../../utils/parser";

// Anthropic Messages API passthrough. The app's AI SDK client sends
// /v1/messages-shaped payloads verbatim (no transformation in the proxy
// fetch interceptor), so this handler only enforces auth, quota and the
// proxy-tier model allowlist before forwarding — streaming included.
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// Proxy tier: only the cheapest Claude. Stronger models require the user's
// own key in the app (never proxied).
const ALLOWED_CLAUDE_MODELS = new Set(["claude-haiku-4-5-20251001"]);
const DEFAULT_CLAUDE_MODEL = "claude-haiku-4-5-20251001";

export const handleClaudeChat = async (
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

  // Owner-funded proxy: signed-in (or anonymous) users, metered per uid (A6)
  const auth = await verifyFirebaseIdToken(req, res);
  if (!auth) {
    return;
  }
  if (!(await checkAndConsumeQuota(auth.uid, res, "chat", auth.isAnonymous))) {
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res
      .status(500)
      .json({error: "Server misconfiguration: Anthropic key missing"});
    return;
  }

  const payload = parseJsonBody(req) as Record<string, unknown>;

  if (!Array.isArray(payload.messages)) {
    res.status(400).json({error: "Request must include messages"});
    return;
  }

  const requestedModel =
    typeof payload.model === "string" ? payload.model : undefined;
  const model =
    requestedModel && ALLOWED_CLAUDE_MODELS.has(requestedModel) ?
      requestedModel :
      DEFAULT_CLAUDE_MODEL;
  if (requestedModel && requestedModel !== model) {
    logger.info(`Forcing Claude model ${requestedModel} -> ${model}`);
  }

  const body = JSON.stringify({...payload, model});
  const isStreaming = payload.stream === true;

  const upstream = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "Content-Type": "application/json",
    },
    body,
  });

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    logger.error("Anthropic API error", {
      status: upstream.status,
      detail: detail.slice(0, 2000),
    });
    // Surface Anthropic's curated message when parseable; never raw internals
    let message = "Upstream request failed";
    try {
      const parsed = JSON.parse(detail) as {error?: {message?: string}};
      if (typeof parsed.error?.message === "string") {
        message = parsed.error.message;
      }
    } catch {
      // keep generic message
    }
    res.status(upstream.status).json({error: message});
    return;
  }

  if (isStreaming && upstream.body) {
    res.status(200);
    res.setHeader(
      "Content-Type",
      upstream.headers.get("content-type") ?? "text/event-stream",
    );
    res.setHeader("Cache-Control", "no-cache");
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    } finally {
      res.end();
    }
    return;
  }

  const data = (await upstream.json()) as unknown;
  res.status(200).json(data);
};

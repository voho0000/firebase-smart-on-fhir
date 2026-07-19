import type {Request, Response} from "express";
import * as logger from "firebase-functions/logger";
import {verifyClientKey, verifyFirebaseIdToken} from "../../middleware/auth";
import {verifyAppCheck} from "../../middleware/appCheck";
import {checkAndConsumeQuota} from "../../middleware/quota";
import {parseJsonBody} from "../../utils/parser";
import {resolveGatewayTarget} from "./target";

const MAX_JSON_BYTES = 5 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 8 * 60 * 1000;

const copyResponseHeaders = (upstream: globalThis.Response, res: Response) => {
  const contentType = upstream.headers.get("content-type");
  if (contentType) res.setHeader("Content-Type", contentType);
  // Clinical prompts and completions must never become browser/shared-cache
  // entries, regardless of the provider's cache policy.
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
};

const waitForDrain = (res: Response): Promise<void> => new Promise(
  (resolve, reject) => {
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("close", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Gateway client disconnected"));
    };
    res.once("close", onClose);
    res.once("drain", onDrain);
    // Close may have happened immediately before the listeners were attached.
    if (res.destroyed || res.writableEnded) onClose();
  },
);

const relayBody = async (
  upstream: globalThis.Response,
  res: Response,
): Promise<void> => {
  copyResponseHeaders(upstream, res);
  res.status(upstream.status);

  if (!upstream.body) {
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  let completed = false;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      if (res.destroyed || res.writableEnded) break;
      if (!res.write(Buffer.from(value))) await waitForDrain(res);
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    if (!res.writableEnded && !res.destroyed) res.end();
    reader.releaseLock();
  }
};

export const handleOpenAiCompatibleGateway = async (
  req: Request,
  res: Response,
): Promise<void> => {
  if (req.method !== "GET" && req.method !== "POST") {
    res.set("Allow", "GET, POST, OPTIONS");
    res.status(405).send("Method not allowed");
    return;
  }

  if (!verifyClientKey(req, res)) return;
  if (!(await verifyAppCheck(req, res))) return;

  const auth = await verifyFirebaseIdToken(req, res);
  if (!auth) return;
  if (!(await checkAndConsumeQuota(
    auth.uid,
    res,
    "gateway",
    auth.isAnonymous,
  ))) return;

  let target: string;
  try {
    target = resolveGatewayTarget(
      req.header("x-upstream-base-url"),
      req.header("x-upstream-path"),
      req.method,
    );
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Invalid gateway target",
    });
    return;
  }

  const upstreamKey = req.header("x-upstream-api-key")?.trim();
  if (upstreamKey && upstreamKey.length > 4096) {
    res.status(400).json({error: "Upstream API key is too long"});
    return;
  }

  let body: string | undefined;
  if (req.method === "POST") {
    try {
      body = JSON.stringify(parseJsonBody(req));
    } catch {
      res.status(400).json({error: "Invalid JSON payload"});
      return;
    }
    if (Buffer.byteLength(body, "utf8") > MAX_JSON_BYTES) {
      res.status(413).json({error: "Gateway request body is too large"});
      return;
    }
  }

  const controller = new AbortController();
  let didTimeout = false;
  let clientDisconnected = false;
  const timeout = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, UPSTREAM_TIMEOUT_MS);
  const abortForClient = () => {
    clientDisconnected = true;
    controller.abort();
  };
  const abortOnResponseClose = () => {
    if (!res.writableEnded) abortForClient();
  };
  req.once("aborted", abortForClient);
  res.once("close", abortOnResponseClose);
  // Auth/quota can include cold-start latency. If the browser disconnected
  // before these listeners were attached, the state flags still fail closed.
  if (req.aborted || res.destroyed) abortForClient();

  try {
    if (clientDisconnected) return;
    const headers: Record<string, string> = {
      "Accept": req.header("accept") ?? "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (upstreamKey) headers.Authorization = `Bearer ${upstreamKey}`;

    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
      redirect: "manual",
      signal: controller.signal,
    });

    if (upstream.status >= 300 && upstream.status < 400) {
      logger.warn("OpenAI-compatible gateway rejected upstream redirect", {
        target,
        status: upstream.status,
      });
      res.status(502).json({error: "Upstream redirects are not allowed"});
      return;
    }

    await relayBody(upstream, res);
  } catch (error) {
    if (clientDisconnected) return;
    logger.warn("OpenAI-compatible gateway request failed", {
      target,
      timedOut: didTimeout,
      message: error instanceof Error ? error.message : String(error),
    });
    if (!res.writableEnded && !res.destroyed) {
      if (res.headersSent) {
        res.end();
      } else {
        res.status(didTimeout ? 504 : 502).json({
          error: didTimeout ?
            "Upstream request timed out" :
            "Upstream unavailable",
        });
      }
    }
  } finally {
    clearTimeout(timeout);
    req.off("aborted", abortForClient);
    res.off("close", abortOnResponseClose);
  }
};

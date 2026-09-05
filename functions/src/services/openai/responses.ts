import type {Response} from "express";
import axios, {isAxiosError} from "axios";
import * as logger from "firebase-functions/logger";
import {
  ALLOWED_OPENAI_RESPONSES_MODEL_IDS,
} from "../../config/constants";
import {getOpenAiApiKey, getOpenAiBaseUrl} from "../../config/runtime";

const ALLOWED_RESPONSES_KEYS = new Set([
  "input",
  "instructions",
  "max_output_tokens",
  "reasoning",
  "text",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "stream",
  "include",
  "truncation",
]);

export const isOpenAiResponsesBody = (
  payload: Record<string, unknown>,
): boolean => {
  const model = payload["model"];
  return (
    typeof model === "string" &&
    ALLOWED_OPENAI_RESPONSES_MODEL_IDS.has(model) &&
    Object.prototype.hasOwnProperty.call(payload, "input")
  );
};

export const sanitizeResponsesPayload = (
  payload: Record<string, unknown>,
): Record<string, unknown> => {
  const requestedModel = payload["model"];
  if (
    typeof requestedModel !== "string" ||
    !ALLOWED_OPENAI_RESPONSES_MODEL_IDS.has(requestedModel)
  ) {
    throw new Error("OpenAI Responses model is not proxy-eligible");
  }

  const sanitized: Record<string, unknown> = {
    model: requestedModel,
    // Clinical requests must not opt into OpenAI response storage.
    store: false,
  };
  for (const key of ALLOWED_RESPONSES_KEYS) {
    if (payload[key] !== undefined) {
      sanitized[key] = payload[key];
    }
  }
  return sanitized;
};

export const extractOpenAiResponseText = (
  data: Record<string, unknown>,
): string | null => {
  if (typeof data["output_text"] === "string") {
    return data["output_text"].trim() || null;
  }
  const output = data["output"];
  if (!Array.isArray(output)) return null;

  const text = output
    .filter((item) => (
      typeof item === "object" &&
      item !== null &&
      (item as {type?: unknown}).type === "message"
    ))
    .flatMap((item) => {
      const content = (item as {content?: unknown}).content;
      return Array.isArray(content) ? content : [];
    })
    .filter((part) => (
      typeof part === "object" &&
      part !== null &&
      (part as {type?: unknown}).type === "output_text"
    ))
    .map((part) => {
      const value = (part as {text?: unknown}).text;
      return typeof value === "string" ? value : "";
    })
    .join("")
    .trim();
  return text || null;
};

const upstreamErrorContext = (error: unknown): Record<string, unknown> => {
  if (!isAxiosError(error)) {
    return {
      message: error instanceof Error ? error.message : String(error),
    };
  }

  // With responseType:"stream", response.data is a live Node stream. Trying
  // to JSON.stringify it dumps internal buffers into Cloud Logging and still
  // hides the useful signal. Keep only bounded, non-secret diagnostics.
  const requestId = error.response?.headers?.["x-request-id"];
  return {
    message: error.message,
    code: error.code,
    status: error.response?.status,
    requestId: typeof requestId === "string" ? requestId : undefined,
  };
};

const responsesError = (message: string) => ({
  error: {
    type: "upstream_error",
    code: "upstream_error",
    message,
    param: null,
  },
});

const responsesErrorEvent = (message: string): string => `data: ${
  JSON.stringify({
    type: "error",
    sequence_number: 0,
    error: responsesError(message).error,
  })
}\n\n`;

export const handleOpenAiResponses = async (
  payload: Record<string, unknown>,
  res: Response,
  post: typeof axios.post = axios.post,
): Promise<void> => {
  const apiKey = getOpenAiApiKey();
  const request = sanitizeResponsesPayload(payload);
  const url = `${getOpenAiBaseUrl()}/responses`;
  const headers = {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  if (request["stream"] !== true) {
    try {
      const upstream = await post(url, request, {headers});
      res.status(200).json({
        message: extractOpenAiResponseText(upstream.data),
        openAiResponse: upstream.data,
      });
    } catch (error) {
      logger.error("OpenAI Responses request failed:", {
        ...upstreamErrorContext(error),
      });
      if (!res.writableEnded) {
        res.status(502).json(responsesError("Upstream request failed"));
      }
    }
    return;
  }

  try {
    const upstream = await post(url, request, {
      headers,
      responseType: "stream",
    });

    // Do not commit HTTP 200 until OpenAI has accepted the request. If the
    // upstream rejects before streaming, the catch block can still return a
    // regular 502 JSON response that the OpenAI SDK understands.
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");
    res.write(`:${" ".repeat(2048)}\n\n`);
    {
      const responseWithFlush = res as Response & {flush?: () => void};
      if (typeof responseWithFlush.flush === "function") {
        responseWithFlush.flush();
      }
    }

    upstream.data.on("data", (chunk: Buffer) => {
      if (!res.writableEnded) {
        try {
          res.write(chunk);
          const responseWithFlush =
            res as Response & {flush?: () => void};
          if (typeof responseWithFlush.flush === "function") {
            responseWithFlush.flush();
          }
        } catch {
          upstream.data.destroy();
        }
      }
    });
    upstream.data.on("end", () => {
      if (!res.writableEnded) res.end();
    });
    upstream.data.on("error", (error: Error) => {
      logger.error("OpenAI Responses stream error:", error);
      if (!res.writableEnded) {
        res.write(responsesErrorEvent("Upstream stream failed"));
        res.end();
      }
    });
  } catch (error) {
    logger.error("OpenAI Responses streaming request failed:", {
      ...upstreamErrorContext(error),
    });
    if (!res.writableEnded) {
      if (!res.headersSent) {
        res.status(502).json(responsesError("Upstream request failed"));
      } else {
        res.write(responsesErrorEvent("Upstream request failed"));
        res.end();
      }
    }
  }
};

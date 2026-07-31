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

const errorDetail = (error: unknown): string => (
  isAxiosError(error) ?
    JSON.stringify(error.response?.data)?.slice(0, 1500) :
    String(error)
);

export const handleOpenAiResponses = async (
  payload: Record<string, unknown>,
  res: Response,
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
      const upstream = await axios.post(url, request, {headers});
      res.status(200).json({
        message: extractOpenAiResponseText(upstream.data),
        openAiResponse: upstream.data,
      });
    } catch (error) {
      logger.error("OpenAI Responses request failed:", {
        detail: errorDetail(error),
      });
      if (!res.writableEnded) {
        res.status(502).json({error: "Upstream request failed"});
      }
    }
    return;
  }

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

  try {
    const upstream = await axios.post(url, request, {
      headers,
      responseType: "stream",
    });
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
        res.write(
          `data: ${JSON.stringify({error: "stream error"})}\n\n`,
        );
        res.end();
      }
    });
  } catch (error) {
    logger.error("OpenAI Responses streaming request failed:", {
      detail: errorDetail(error),
    });
    if (!res.writableEnded) {
      res.write(
        `data: ${JSON.stringify({error: "Upstream request failed"})}\n\n`,
      );
      res.end();
    }
  }
};

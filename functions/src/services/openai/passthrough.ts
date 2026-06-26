import type {Response} from "express";
import axios, {isAxiosError} from "axios";
import * as logger from "firebase-functions/logger";
import {getOpenAiApiKey, getOpenAiBaseUrl} from "../../config/runtime";
import {sanitizeChatPayload} from "./utils";

// Native OpenAI passthrough (Gemini/Claude agent-tool fix, applied to GPT).
//
// The legacy path ran messages through normalizeChatMessages +
// transformMessagesForOpenAI, both of which keep only {role, content}. That
// DROPPED tool_calls off assistant turns (and dropped the whole turn when its
// content was empty — which a tool-call-only turn is) and stripped
// tool_call_id off role:"tool" results. OpenAI then 400s ("tool message with
// no preceding tool_calls"), the agent never sees its tool results, loops,
// and gives up. Forwarding the messages verbatim keeps the tool protocol
// intact. The model is forced to the proxy tier server-side.

interface OpenAiMessage {
  role?: unknown;
  content?: unknown;
  tool_calls?: unknown;
}

// Native = carries OpenAI tool-protocol messages or multimodal content arrays
// that the lossy legacy transform would destroy. Plain {role, content:string}
// chat (normal mode) still takes the legacy path.
export const isNativeOpenAiBody = (
  payload: Record<string, unknown>,
): boolean => {
  const messages = payload["messages"];
  if (!Array.isArray(messages)) {
    return false;
  }
  return messages.some((m) => {
    if (typeof m !== "object" || m === null) {
      return false;
    }
    const msg = m as OpenAiMessage;
    return (
      msg.role === "tool" ||
      Array.isArray(msg.tool_calls) ||
      Array.isArray(msg.content)
    );
  });
};

export const handleOpenAiPassthrough = async (
  payload: Record<string, unknown>,
  res: Response,
): Promise<void> => {
  const apiKey = getOpenAiApiKey();
  const baseUrl = getOpenAiBaseUrl();

  // Forward messages VERBATIM (tool_calls / tool_call_id / role:"tool" /
  // multimodal content) instead of the lossy normalize path.
  const messages = payload["messages"] as unknown[];
  const chatRequest = sanitizeChatPayload(payload, messages);

  // Proxy tier — never trust the client model; gpt-5 reasoning models also
  // require temperature 1.
  chatRequest.model = "gpt-5.4-nano";
  if (
    typeof chatRequest.temperature === "number" &&
    chatRequest.temperature !== 1
  ) {
    chatRequest.temperature = 1;
  }

  const isStreaming = payload["stream"] === true;
  const url = `${baseUrl}/chat/completions`;
  const authHeaders = {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  if (!isStreaming) {
    try {
      const upstream = await axios.post(url, chatRequest, {
        headers: authHeaders,
      });
      res.status(200).json({
        message: upstream.data?.choices?.[0]?.message?.content?.trim() ?? null,
        openAiResponse: upstream.data,
      });
    } catch (error) {
      const detail = isAxiosError(error) ?
        JSON.stringify(error.response?.data)?.slice(0, 1500) :
        String(error);
      logger.error("OpenAI passthrough (non-stream) failed:", {detail});
      if (!res.writableEnded) {
        res.status(502).json({error: "Upstream request failed"});
      }
    }
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  // No `Connection: keep-alive` / `Transfer-Encoding: chunked` — forbidden over
  // HTTP/2 (browser↔Cloud Run); iOS WebKit rejects the response ("Load failed")
  // when present. See gemini/passthrough.ts for the full rationale.

  // Prime the stream past iOS WebKit's ~1KB delivery buffer (SSE comment line,
  // ignored by parsers) so iOS surfaces chunks immediately instead of stalling.
  res.write(`:${" ".repeat(2048)}\n\n`);
  {
    const r = res as Response & {flush?: () => void};
    if (typeof r.flush === "function") r.flush();
  }

  try {
    const upstream = await axios.post(url, chatRequest, {
      headers: authHeaders,
      responseType: "stream",
    });

    upstream.data.on("data", (chunk: Buffer) => {
      if (!res.writableEnded) {
        try {
          res.write(chunk);
          const r = res as Response & {flush?: () => void};
          if (typeof r.flush === "function") r.flush();
        } catch {
          upstream.data.destroy();
        }
      }
    });
    upstream.data.on("end", () => {
      if (!res.writableEnded) res.end();
    });
    upstream.data.on("error", (error: Error) => {
      logger.error("OpenAI passthrough stream error:", error);
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({error: "stream error"})}\n\n`);
        res.end();
      }
    });
  } catch (error) {
    const detail = isAxiosError(error) ?
      JSON.stringify(error.response?.data)?.slice(0, 1500) :
      String(error);
    logger.error("OpenAI passthrough streaming failed:", {detail});
    if (!res.writableEnded) {
      res.write(
        `data: ${JSON.stringify({error: "Upstream request failed"})}\n\n`,
      );
      res.end();
    }
  }
};

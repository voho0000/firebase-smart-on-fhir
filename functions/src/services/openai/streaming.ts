import type {Response} from "express";
import axios from "axios";
import {getOpenAiApiKey, getOpenAiBaseUrl} from "../../config/runtime";
import type {ChatMessage} from "../../types/common";
import {transformMessagesForOpenAI} from "./utils";

export const handleOpenAIStreaming = async (
  model: string,
  normalizedMessages: ChatMessage[],
  chatRequest: Record<string, unknown>,
  res: Response,
): Promise<void> => {
  const apiKey = getOpenAiApiKey();

  const transformedMessages = transformMessagesForOpenAI(normalizedMessages);
  const requestWithTransformedMessages = {
    ...chatRequest,
    messages: transformedMessages,
  };

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  // No `Connection` / `Transfer-Encoding` — both forbidden over HTTP/2; iOS
  // WebKit rejects the response ("Load failed") when present.
  // See gemini/passthrough.ts for the full rationale.

  // iOS Safari/WebKit buffers a streamed fetch response until ~1KB has arrived
  // before surfacing ANY chunk to the client, so iOS clients saw nothing and
  // tripped the app's 60s idle-timeout while desktop worked. Prime with a >1KB
  // SSE comment line (':' prefix, ignored by SSE parsers) + flush so delivery
  // starts immediately. Harmless on desktop.
  res.write(`:${" ".repeat(2048)}\n\n`);
  {
    const resWithFlush = res as Response & {flush?: () => void};
    if (typeof resWithFlush.flush === "function") {
      resWithFlush.flush();
    }
  }

  try {
    const response = await axios.post(
      `${getOpenAiBaseUrl()}/chat/completions`,
      requestWithTransformedMessages,
      {
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        responseType: "stream",
      },
    );

    response.data.on("data", (chunk: Buffer) => {
      if (!res.writableEnded) {
        try {
          res.write(chunk);
          const resWithFlush = res as Response & {flush?: () => void};
          if (typeof resWithFlush.flush === "function") {
            resWithFlush.flush();
          }
        } catch (writeError) {
          response.data.destroy();
        }
      }
    });

    response.data.on("end", () => {
      if (!res.writableEnded) {
        res.end();
      }
    });

    response.data.on("error", (error: Error) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({error: error.message})}\n\n`);
        res.end();
      }
    });
  } catch (error) {
    if (!res.writableEnded) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      res.write(`data: ${JSON.stringify({error: errorMessage})}\n\n`);
      res.end();
    }
  }
};

import type {Response} from "express";
import {createGoogleGenerativeAI} from "@ai-sdk/google";
import {streamText} from "ai";
import * as logger from "firebase-functions/logger";
import {getGeminiApiKey} from "../../config/runtime";
import type {GeminiStreamOptions} from "./types";
import type {ChatMessage} from "../../types/common";

export const handleGeminiStreaming = async (
  model: string,
  normalizedMessages: ChatMessage[],
  generationConfig: Record<string, unknown> | undefined,
  res: Response,
): Promise<void> => {
  const apiKey = getGeminiApiKey();
  const google = createGoogleGenerativeAI({apiKey});
  const geminiModel = google(model);

  const streamOptions: GeminiStreamOptions = {
    model: geminiModel,
    messages: normalizedMessages as Array<{
      role: "user" | "assistant" | "system";
      content: string;
    }>,
  };

  if (generationConfig) {
    if (typeof generationConfig.temperature === "number") {
      streamOptions.temperature = generationConfig.temperature;
    }

    if (typeof generationConfig.maxOutputTokens === "number") {
      streamOptions.maxTokens = generationConfig.maxOutputTokens;
    }

    if (typeof generationConfig.topP === "number") {
      streamOptions.topP = generationConfig.topP;
    }

    if (typeof generationConfig.topK === "number") {
      streamOptions.topK = generationConfig.topK;
    }
  }

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Vercel-AI-Data-Stream", "v1");
  res.setHeader("Transfer-Encoding", "chunked");

  const result = await streamText(streamOptions);

  try {
    for await (const chunk of result.fullStream) {
      if (chunk.type === "text-delta") {
        if (!res.writableEnded) {
          try {
            res.write(`0:${JSON.stringify(chunk.text)}\n`);
            const resWithFlush = res as Response & {flush?: () => void};
            if (typeof resWithFlush.flush === "function") {
              resWithFlush.flush();
            }
          } catch (writeError) {
            logger.info("Client disconnected, stopping stream");
            break;
          }
        } else {
          break;
        }
      } else if (chunk.type === "finish") {
        if (!res.writableEnded) {
          try {
            res.write(`d:{"finishReason":"${chunk.finishReason}"}\n`);
          } catch (writeError) {
            break;
          }
        }
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes("write after end") ||
        errorMessage.includes("EPIPE") ||
        errorMessage.includes("ECONNRESET")) {
      logger.info("Stream interrupted by client disconnect");
    } else {
      throw error;
    }
  }

  if (!res.writableEnded) {
    res.end();
  }
};

import type {Response} from "express";
import {createOpenAI} from "@ai-sdk/openai";
import {streamText} from "ai";
import {getOpenAiApiKey} from "../../config/runtime";
import type {OpenAIStreamOptions} from "./types";

export const handleOpenAIStreaming = async (
  model: string,
  normalizedMessages: Array<{
    role: "user" | "assistant" | "system";
    content: string;
  }>,
  chatRequest: Record<string, unknown>,
  res: Response,
): Promise<void> => {
  const apiKey = getOpenAiApiKey();
  const openai = createOpenAI({apiKey});
  const openaiModel = openai(model as string);

  const streamOptions: OpenAIStreamOptions = {
    model: openaiModel,
    messages: normalizedMessages,
  };

  if (typeof chatRequest.temperature === "number") {
    streamOptions.temperature = chatRequest.temperature;
  }

  if (typeof chatRequest.max_tokens === "number") {
    streamOptions.maxCompletionTokens = chatRequest.max_tokens;
  }

  if (typeof chatRequest.top_p === "number") {
    streamOptions.topP = chatRequest.top_p;
  }

  if (typeof chatRequest.frequency_penalty === "number") {
    streamOptions.frequencyPenalty = chatRequest.frequency_penalty;
  }

  if (typeof chatRequest.presence_penalty === "number") {
    streamOptions.presencePenalty = chatRequest.presence_penalty;
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
    if (!errorMessage.includes("write after end") &&
        !errorMessage.includes("EPIPE") &&
        !errorMessage.includes("ECONNRESET")) {
      throw error;
    }
  }

  if (!res.writableEnded) {
    res.end();
  }
};

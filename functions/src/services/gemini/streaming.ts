import type {Response} from "express";
import {google} from "@ai-sdk/google";
import {streamText} from "ai";
import type {GeminiStreamOptions} from "./types";
import type {ChatMessage} from "../../types/common";

export const handleGeminiStreaming = async (
  model: string,
  normalizedMessages: ChatMessage[],
  generationConfig: Record<string, unknown> | undefined,
  res: Response,
): Promise<void> => {
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

  for await (const chunk of result.fullStream) {
    if (chunk.type === "text-delta") {
      res.write(`0:${JSON.stringify(chunk.text)}\n`);
      if (typeof (res as any).flush === "function") {
        (res as any).flush();
      }
    } else if (chunk.type === "finish") {
      res.write(`d:{"finishReason":"${chunk.finishReason}"}\n`);
    }
  }

  res.end();
};

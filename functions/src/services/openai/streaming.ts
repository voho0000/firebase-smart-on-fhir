import type {Response} from "express";
import {openai} from "@ai-sdk/openai";
import {streamText} from "ai";
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

  const result = streamText(streamOptions);

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Vercel-AI-Data-Stream", "v1");

  for await (const chunk of result.fullStream) {
    if (chunk.type === "text-delta") {
      res.write(`0:${JSON.stringify(chunk.text)}\n`);
    } else if (chunk.type === "finish") {
      res.write(`d:{"finishReason":"${chunk.finishReason}"}\n`);
    }
  }

  res.end();
};

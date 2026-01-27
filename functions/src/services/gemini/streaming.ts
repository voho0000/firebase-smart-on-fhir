import type {Response} from "express";
import axios from "axios";
import * as logger from "firebase-functions/logger";
import {getGeminiApiKey, getGeminiBaseUrl} from "../../config/runtime";
import type {ChatMessage} from "../../types/common";
import {transformMessagesForGemini} from "./utils";

export const handleGeminiStreaming = async (
  model: string,
  normalizedMessages: ChatMessage[],
  generationConfig: Record<string, unknown> | undefined,
  tools: unknown,
  toolConfig: unknown,
  safetySettings: unknown,
  responseSchema: unknown,
  responseMimeType: unknown,
  res: Response,
): Promise<void> => {
  const apiKey = getGeminiApiKey();
  const baseUrl = getGeminiBaseUrl();

  const systemMessages = normalizedMessages.filter(
    (message) => message.role === "system",
  );

  const contents = transformMessagesForGemini(normalizedMessages);

  const requestBody: Record<string, unknown> = {contents};

  if (systemMessages.length > 0) {
    requestBody.systemInstruction = {
      role: "system",
      parts: [{
        text: systemMessages.map((message) => message.content).join("\n"),
      }],
    };
  }

  if (generationConfig) {
    requestBody.generationConfig = generationConfig;
  }

  if (Array.isArray(safetySettings)) {
    requestBody.safetySettings = safetySettings;
  }

  if (Array.isArray(tools)) {
    requestBody.tools = tools;
  }

  if (toolConfig !== undefined) {
    requestBody.toolConfig = toolConfig;
  }

  if (responseSchema !== undefined) {
    requestBody.responseSchema = responseSchema;
  }

  if (typeof responseMimeType === "string") {
    requestBody.responseMimeType = responseMimeType;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Transfer-Encoding", "chunked");

  try {
    const response = await axios.post(
      `${baseUrl}/models/${model}:streamGenerateContent`,
      requestBody,
      {
        params: {key: apiKey, alt: "sse"},
        headers: {"Content-Type": "application/json"},
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
          logger.info("Client disconnected, stopping stream");
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
      logger.error("Gemini stream error:", error);
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({error: error.message})}\n\n`);
        res.end();
      }
    });
  } catch (error) {
    logger.error("Gemini streaming request failed:", error);
    if (!res.writableEnded) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      res.write(`data: ${JSON.stringify({error: errorMessage})}\n\n`);
      res.end();
    }
  }
};

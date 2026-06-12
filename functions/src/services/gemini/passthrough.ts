import type {Response} from "express";
import axios, {isAxiosError} from "axios";
import * as logger from "firebase-functions/logger";
import {
  getGeminiApiKey,
  getGeminiBaseUrl,
  getGeminiDefaultModel,
} from "../../config/runtime";

// Native Gemini passthrough (audit C6 / Gemini agent-tool fix).
//
// The AI SDK produces native generateContent bodies (contents[] with
// functionCall/functionResponse parts, tools, systemInstruction,
// generationConfig). Forwarding them verbatim — instead of the old lossy
// flatten to {role, content:string} — keeps multi-step tool loops intact.
// The model is forced to the proxy tier server-side regardless of input.

interface NativeBody {
  contents?: unknown;
  __proxyStreaming?: boolean;
  model?: unknown;
  generationConfig?: {temperature?: number} & Record<string, unknown>;
  [key: string]: unknown;
}

export const isNativeGeminiBody = (payload: unknown): payload is NativeBody =>
  typeof payload === "object" &&
  payload !== null &&
  Array.isArray((payload as NativeBody).contents);

export const handleGeminiPassthrough = async (
  payload: NativeBody,
  res: Response,
): Promise<void> => {
  const apiKey = getGeminiApiKey();
  const baseUrl = getGeminiBaseUrl();
  // proxy tier — never trust the client-supplied model
  const model = getGeminiDefaultModel();

  const isStreaming = payload.__proxyStreaming === true;

  // Strip routing markers; forward everything else to Google verbatim
  const body: Record<string, unknown> = {...payload};
  delete body.__proxyStreaming;
  delete body.model;

  // Flash models only accept temperature 1 on this proxy tier
  if (
    model.toLowerCase().includes("flash") &&
    typeof body.generationConfig === "object" &&
    body.generationConfig !== null
  ) {
    const gc = body.generationConfig as {temperature?: number};
    if (typeof gc.temperature === "number" && gc.temperature !== 1) {
      body.generationConfig = {...gc, temperature: 1};
    }
  }

  const endpoint = isStreaming ? "streamGenerateContent" : "generateContent";

  if (!isStreaming) {
    try {
      const upstream = await axios.post(
        `${baseUrl}/models/${model}:${endpoint}`,
        body,
        {params: {key: apiKey}, headers: {"Content-Type": "application/json"}},
      );
      res.status(200).json(upstream.data);
    } catch (error) {
      const detail = isAxiosError(error) ?
        JSON.stringify(error.response?.data)?.slice(0, 1500) : String(error);
      logger.error("Gemini passthrough (non-stream) failed:", {detail});
      if (!res.writableEnded) {
        res.status(502).json({error: "Upstream request failed"});
      }
    }
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Transfer-Encoding", "chunked");

  try {
    const upstream = await axios.post(
      `${baseUrl}/models/${model}:${endpoint}`,
      body,
      {
        params: {key: apiKey, alt: "sse"},
        headers: {"Content-Type": "application/json"},
        responseType: "stream",
      },
    );

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
      logger.error("Gemini passthrough stream error:", error);
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({error: "stream error"})}\n\n`);
        res.end();
      }
    });
  } catch (error) {
    logger.error("Gemini passthrough streaming request failed:", error);
    if (!res.writableEnded) {
      res.write(
        `data: ${JSON.stringify({error: "Upstream request failed"})}\n\n`,
      );
      res.end();
    }
  }
};

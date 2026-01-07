import {toNumber} from "../../utils/parser";

export const buildGeminiGenerationConfig = (
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined => {
  const generationConfig: Record<string, unknown> = {};

  if (typeof payload["temperature"] === "number") {
    generationConfig.temperature = payload["temperature"];
  }

  if (typeof payload["top_p"] === "number") {
    generationConfig.topP = payload["top_p"];
  }

  if (typeof payload["top_k"] === "number") {
    generationConfig.topK = payload["top_k"];
  }

  if (typeof payload["max_output_tokens"] === "number") {
    generationConfig.maxOutputTokens = payload["max_output_tokens"];
  } else if (typeof payload["max_tokens"] === "number") {
    generationConfig.maxOutputTokens = payload["max_tokens"];
  }

  return Object.keys(generationConfig).length > 0 ?
    generationConfig :
    undefined;
};

export const extractRequestedTemperature = (
  payload: Record<string, unknown>,
  generationConfig?: Record<string, unknown>,
): number | undefined => {
  const directTemperature = toNumber(payload["temperature"]);

  if (typeof directTemperature === "number") {
    return directTemperature;
  }

  const payloadGenerationConfigRaw =
    typeof payload["generationConfig"] === "object" &&
    payload["generationConfig"] !== null ?
      payload["generationConfig"] :
      typeof payload["generation_config"] === "object" &&
          payload["generation_config"] !== null ?
        payload["generation_config"] :
        undefined;

  const sources = [generationConfig, payloadGenerationConfigRaw].filter(
    Boolean,
  ) as Record<string, unknown>[];

  for (const source of sources) {
    const candidate = toNumber(source["temperature"]);

    if (typeof candidate === "number") {
      return candidate;
    }
  }

  return undefined;
};

export const extractGeminiText = (data: unknown): string | undefined => {
  if (!data || typeof data !== "object") {
    return undefined;
  }

  const candidates = (data as {candidates?: unknown[]}).candidates;

  if (!Array.isArray(candidates)) {
    return undefined;
  }

  const texts: string[] = [];

  for (const candidate of candidates) {
    if (
      candidate &&
      typeof candidate === "object" &&
      "content" in candidate
    ) {
      const content = (candidate as {content?: unknown}).content;

      if (
        content &&
        typeof content === "object" &&
        "parts" in content &&
        Array.isArray((content as {parts?: unknown}).parts)
      ) {
        const parts = (content as {parts: unknown[]}).parts;

        for (const part of parts) {
          if (
            part &&
            typeof part === "object" &&
            "text" in part &&
            typeof (part as {text?: unknown}).text === "string"
          ) {
            texts.push((part as {text: string}).text);
          }
        }
      }
    }
  }

  const combined = texts.join("\n").trim();
  return combined.length > 0 ? combined : undefined;
};

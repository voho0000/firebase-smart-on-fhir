import type {Request} from "express";
import type {ChatMessage} from "../types/common";

export const parseList = (value?: string): string[] =>
  value ?
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean) :
    [];

export const parseJsonBody = (req: Request): Record<string, unknown> => {
  if (!req.body) {
    return {};
  }

  if (typeof req.body === "object") {
    return req.body as Record<string, unknown>;
  }

  if (typeof req.body === "string" && req.body.length > 0) {
    try {
      return JSON.parse(req.body) as Record<string, unknown>;
    } catch (error) {
      throw new Error("Invalid JSON payload");
    }
  }

  return {};
};

export const toPlainText = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    const texts = value
      .map((item) => {
        if (
          typeof item === "object" &&
          item !== null &&
          "text" in item &&
          typeof (item as {text?: unknown}).text === "string"
        ) {
          return (item as {text: string}).text;
        }

        return undefined;
      })
      .filter(Boolean) as string[];

    if (texts.length > 0) {
      return texts.join(" ");
    }
  }

  if (
    typeof value === "object" &&
    value !== null &&
    "text" in value &&
    typeof (value as {text?: unknown}).text === "string"
  ) {
    return (value as {text: string}).text;
  }

  return undefined;
};

export const normalizeChatMessages = (messages: unknown[]): ChatMessage[] =>
  messages
    .map((message) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        typeof (message as {role?: unknown}).role === "string" &&
        "content" in message
      ) {
        const role = (message as {role: string}).role;
        const rawContent = (message as {content?: unknown}).content;
        const content = toPlainText(rawContent);

        if (content) {
          const normalized: ChatMessage = {role, content};

          const rawImages = (message as {images?: unknown}).images;
          if (Array.isArray(rawImages) && rawImages.length > 0) {
            normalized.images = rawImages
              .filter((img) =>
                typeof img === "object" &&
                img !== null &&
                "data" in img &&
                typeof (img as {data?: unknown}).data === "string"
              )
              .map((img) => ({
                data: (img as {data: string}).data,
                mimeType: (img as {mimeType?: string}).mimeType,
              }));
          }

          return normalized;
        }
      }

      return undefined;
    })
    .filter(Boolean) as ChatMessage[];

export const buildMessages = (
  payload: Record<string, unknown>,
): unknown[] | undefined => {
  if (Array.isArray(payload["messages"])) {
    return payload["messages"];
  }

  if (typeof payload["inputText"] === "string" && payload["inputText"]) {
    return [{role: "user", content: payload["inputText"]}];
  }

  return undefined;
};

export const toNumber = (value: unknown): number | undefined => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
};

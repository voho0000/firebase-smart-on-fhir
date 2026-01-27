import {ALLOWED_MODEL_IDS, ALLOWED_OPENAI_KEYS} from "../../config/constants";
import type {ChatMessage} from "../../types/common";

export const transformMessagesForOpenAI = (
  messages: ChatMessage[],
): Array<{role: string; content: string | Array<Record<string, unknown>>}> => {
  return messages.map((msg) => {
    if (msg.images && msg.images.length > 0) {
      const content: Array<Record<string, unknown>> = [
        {type: "text", text: msg.content},
      ];

      for (const img of msg.images) {
        content.push({
          type: "image_url",
          image_url: {
            url: img.data,
          },
        });
      }

      return {
        role: msg.role,
        content,
      };
    }

    return {
      role: msg.role,
      content: msg.content,
    };
  });
};

export const sanitizeChatPayload = (
  payload: Record<string, unknown>,
  messages: unknown[],
): Record<string, unknown> => {
  const allowedKeys = ALLOWED_OPENAI_KEYS;

  const requestedModel =
    typeof payload["model"] === "string" ? payload["model"] : undefined;

  const sanitized: Record<string, unknown> = {messages};

  for (const key of allowedKeys) {
    if (payload[key] !== undefined) {
      sanitized[key] = payload[key];
    }
  }

  if (requestedModel && ALLOWED_MODEL_IDS.has(requestedModel)) {
    sanitized.model = requestedModel;
  }

  if (!sanitized.model) {
    sanitized.model = "gpt-5-mini";
  }

  if (sanitized.temperature === undefined) {
    sanitized.temperature = 0.5;
  }

  return sanitized;
};

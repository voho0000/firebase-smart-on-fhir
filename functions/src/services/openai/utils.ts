import {ALLOWED_MODEL_IDS, ALLOWED_OPENAI_KEYS} from "../../config/constants";

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

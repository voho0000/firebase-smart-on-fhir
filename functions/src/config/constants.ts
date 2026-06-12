// Proxy tier only — stronger models require the user's own key in the app
export const ALLOWED_MODEL_IDS = new Set<string>(["gpt-5.4-nano"]);

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";
export const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export const ALLOWED_OPENAI_KEYS = [
  "messages",
  "model",
  "temperature",
  "max_tokens",
  "top_p",
  "frequency_penalty",
  "presence_penalty",
  "stop",
  "n",
  "stream",
  "logit_bias",
  "user",
  "presence_penalty",
  "response_format",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "functions",
  "function_call",
  "seed",
];

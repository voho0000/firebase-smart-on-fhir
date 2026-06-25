// Proxy tier only — stronger models require the user's own key in the app
export const ALLOWED_MODEL_IDS = new Set<string>(["gpt-5.4-nano"]);

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";

// Gemini models the owner-funded proxy will run on the server key. Must stay in
// sync with the app's free (non-requiresUserKey) Gemini models. Anything not in
// this set is forced back to DEFAULT_GEMINI_MODEL so pro-tier models can't bill
// the server key.
export const ALLOWED_GEMINI_MODEL_IDS = new Set<string>([
  "gemini-3.1-flash-lite",
  "gemini-3-flash-preview",
]);
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

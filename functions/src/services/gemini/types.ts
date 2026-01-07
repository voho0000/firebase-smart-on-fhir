export type GeminiStreamOptions = {
  model: ReturnType<typeof import("@ai-sdk/google").google>;
  messages: Array<{
    role: "user" | "assistant" | "system";
    content: string;
  }>;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
};

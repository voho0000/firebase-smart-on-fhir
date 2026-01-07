export type OpenAIStreamOptions = {
  model: ReturnType<typeof import("@ai-sdk/openai").openai>;
  messages: Array<{
    role: "user" | "assistant" | "system";
    content: string;
  }>;
  temperature?: number;
  maxCompletionTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
};

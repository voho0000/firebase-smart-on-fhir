import {
  extractOpenAiResponseText,
  isOpenAiResponsesBody,
  sanitizeResponsesPayload,
} from "../functions/src/services/openai/responses";

describe("OpenAI Responses proxy policy", () => {
  it("accepts Luna Responses payloads and rejects other GPT-5.6 models", () => {
    expect(isOpenAiResponsesBody({
      model: "gpt-5.6-luna",
      input: [{role: "user", content: "hello"}],
    })).toBe(true);
    expect(isOpenAiResponsesBody({
      model: "gpt-5.6-terra",
      input: [{role: "user", content: "hello"}],
    })).toBe(false);
  });

  it("keeps supported Responses fields, strips unknown fields, and disables storage", () => {
    expect(sanitizeResponsesPayload({
      model: "gpt-5.6-luna",
      input: [{role: "user", content: "hello"}],
      max_output_tokens: 2048,
      stream: true,
      store: true,
      metadata: {patient: "must-not-pass"},
      unknown_option: true,
    })).toEqual({
      model: "gpt-5.6-luna",
      input: [{role: "user", content: "hello"}],
      max_output_tokens: 2048,
      stream: true,
      store: false,
    });
    expect(() => sanitizeResponsesPayload({
      model: "gpt-5.6-sol",
      input: "hello",
    })).toThrow("not proxy-eligible");
  });

  it("extracts text from both Responses output shapes", () => {
    expect(extractOpenAiResponseText({
      output_text: " direct text ",
    })).toBe("direct text");
    expect(extractOpenAiResponseText({
      output: [{
        type: "message",
        content: [
          {type: "output_text", text: "hello "},
          {type: "output_text", text: "world"},
        ],
      }],
    })).toBe("hello world");
  });
});

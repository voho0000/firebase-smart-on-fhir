import {
  extractOpenAiResponseText,
  handleOpenAiResponses,
  isOpenAiResponsesBody,
  sanitizeResponsesPayload,
} from "../functions/src/services/openai/responses";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";

type HeaderMap = Record<string, string>;

const mockResponse = () => {
  const chunks: Buffer[] = [];
  const headers: HeaderMap = {};
  const response = Object.assign(new EventEmitter(), {
    statusCode: 200,
    writableEnded: false,
    headersSent: false,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return this;
    },
    write(chunk: Buffer | string) {
      this.headersSent = true;
      chunks.push(Buffer.from(chunk));
      return true;
    },
    end() {
      this.writableEnded = true;
      return this;
    },
    json(value: unknown) {
      this.headersSent = true;
      this.body = value;
      this.writableEnded = true;
      return this;
    },
    _chunks: chunks,
    _headers: headers,
  });
  return response;
};

describe("OpenAI Responses proxy policy", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-openai-key";
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    jest.restoreAllMocks();
  });

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

  it("returns a structured HTTP error when OpenAI rejects before streaming", async () => {
    const post = jest.fn().mockRejectedValueOnce({
      isAxiosError: true,
      message: "Request failed with status code 429",
      code: "ERR_BAD_REQUEST",
      response: {
        status: 429,
        data: new PassThrough(),
        headers: {"x-request-id": "req_test"},
      },
    });
    const res = mockResponse();

    await handleOpenAiResponses({
      model: "gpt-5.6-luna",
      input: [{role: "user", content: "hello"}],
      stream: true,
    }, res as never, post as never);

    expect(res._chunks).toHaveLength(0);
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({
      error: {
        type: "upstream_error",
        code: "upstream_error",
        message: "Upstream request failed",
        param: null,
      },
    });
  });

  it("emits a valid Responses error event when an accepted stream fails", async () => {
    const upstream = new PassThrough();
    const post = jest.fn().mockResolvedValueOnce({data: upstream});
    const res = mockResponse();

    await handleOpenAiResponses({
      model: "gpt-5.6-luna",
      input: [{role: "user", content: "hello"}],
      stream: true,
    }, res as never, post as never);
    upstream.emit("error", new Error("socket closed"));

    const finalChunk = res._chunks.at(-1)?.toString() ?? "";
    const payload = JSON.parse(finalChunk.replace(/^data: /, "").trim());
    expect(payload).toEqual({
      type: "error",
      sequence_number: 0,
      error: {
        type: "upstream_error",
        code: "upstream_error",
        message: "Upstream stream failed",
        param: null,
      },
    });
    expect(res.writableEnded).toBe(true);
  });
});

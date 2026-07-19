jest.mock("../functions/src/middleware/auth", () => ({
  verifyClientKey: jest.fn(() => true),
  verifyFirebaseIdToken: jest.fn(async () => ({
    uid: "test-user",
    isAnonymous: false,
  })),
}));
jest.mock("../functions/src/middleware/appCheck", () => ({
  verifyAppCheck: jest.fn(async () => true),
}));
jest.mock("../functions/src/middleware/quota", () => ({
  checkAndConsumeQuota: jest.fn(async () => true),
}));

import {EventEmitter} from "node:events";

import {handleOpenAiCompatibleGateway} from
  "../functions/src/services/openai-compatible-gateway/handler";

type Hdrs = Record<string, string>;

const mockReq = (
  method: string,
  headers: Hdrs,
  body?: Record<string, unknown>,
) => {
  const lower: Hdrs = {};
  for (const [key, value] of Object.entries(headers)) {
    lower[key.toLowerCase()] = value;
  }
  return Object.assign(new EventEmitter(), {
    method,
    body,
    header: (name: string) => lower[name.toLowerCase()],
  }) as never;
};

const mockRes = () => {
  const chunks: Buffer[] = [];
  const headers: Hdrs = {};
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    writableEnded: false,
    destroyed: false,
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
    set(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return this;
    },
    write(chunk: Buffer) {
      this.headersSent = true;
      chunks.push(Buffer.from(chunk));
      return true;
    },
    end() {
      this.writableEnded = true;
      return this;
    },
    json(value: unknown) {
      this.body = value;
      this.writableEnded = true;
      return this;
    },
    send(value: unknown) {
      this.body = value;
      this.writableEnded = true;
      return this;
    },
    _chunks: chunks,
    _headers: headers,
  });
  return res;
};

describe("handleOpenAiCompatibleGateway", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.OPENAI_COMPATIBLE_GATEWAY_BASE_URLS;
    jest.restoreAllMocks();
  });

  it("forwards the caller key and native NVIDIA request body", async () => {
    const fetchMock = jest.fn(async () => new Response(JSON.stringify({
      choices: [{message: {content: "OK"}}],
    }), {
      status: 200,
      headers: {"Content-Type": "application/json"},
    }));
    global.fetch = fetchMock as typeof fetch;
    const req = mockReq("POST", {
      "x-upstream-base-url": "https://integrate.api.nvidia.com/v1",
      "x-upstream-path": "chat/completions",
      "x-upstream-api-key": "nvapi-user-key",
    }, {
      model: "nvidia/nemotron-3-ultra-550b-a55b",
      messages: [{role: "user", content: "hello"}],
      stream: false,
      chat_template_kwargs: {enable_thinking: true},
      reasoning_budget: 16384,
    });
    const res = mockRes();

    await handleOpenAiCompatibleGateway(req, res as never);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://integrate.api.nvidia.com/v1/chat/completions",
    );
    const upstreamHeaders = new Headers(init?.headers);
    expect(upstreamHeaders.get("Authorization"))
      .toBe("Bearer nvapi-user-key");
    expect(init?.redirect).toBe("manual");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      reasoning_budget: 16384,
      chat_template_kwargs: {enable_thinking: true},
    });
    expect(res.statusCode).toBe(200);
    expect(res._headers["cache-control"]).toBe("no-store");
    expect(Buffer.concat(res._chunks).toString()).toContain("OK");
  });

  it("rejects a non-allow-listed upstream before making a request", async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as typeof fetch;
    const req = mockReq("GET", {
      "x-upstream-base-url": "https://metadata.google.internal/v1",
      "x-upstream-path": "models",
    });
    const res = mockRes();

    await handleOpenAiCompatibleGateway(req, res as never);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: "Upstream endpoint is not allowed by this gateway",
    });
  });

  it("does not follow an upstream redirect", async () => {
    const fetchMock = jest.fn(async () => new Response(null, {
      status: 302,
      headers: {Location: "http://169.254.169.254/latest/meta-data"},
    }));
    global.fetch = fetchMock as typeof fetch;
    const req = mockReq("GET", {
      "x-upstream-base-url": "https://integrate.api.nvidia.com/v1",
      "x-upstream-path": "models",
    });
    const res = mockRes();

    await handleOpenAiCompatibleGateway(req, res as never);

    expect(fetchMock.mock.calls[0][1]?.redirect).toBe("manual");
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({error: "Upstream redirects are not allowed"});
  });

  it("aborts the upstream request when the browser disconnects", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const fetchMock = jest.fn((_url: string | URL | Request, init?: RequestInit) => {
      upstreamSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        upstreamSignal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        }, {once: true});
      });
    });
    global.fetch = fetchMock as typeof fetch;
    const req = mockReq("POST", {
      "x-upstream-base-url": "https://integrate.api.nvidia.com/v1",
      "x-upstream-path": "chat/completions",
    }, {model: "test", messages: [], stream: true});
    const res = mockRes();

    const pending = handleOpenAiCompatibleGateway(req, res as never);
    while (fetchMock.mock.calls.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    res.destroyed = true;
    res.emit("close");
    await pending;

    expect(upstreamSignal?.aborted).toBe(true);
    expect(res.writableEnded).toBe(false);
  });
});

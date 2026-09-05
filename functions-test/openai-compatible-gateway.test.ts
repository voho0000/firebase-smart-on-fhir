import {
  getAllowedGatewayBaseUrls,
  resolveGatewayTarget,
} from "../functions/src/services/openai-compatible-gateway/target";

describe("OpenAI-compatible gateway target validation", () => {
  const oldAllowed = process.env.OPENAI_COMPATIBLE_GATEWAY_BASE_URLS;

  afterEach(() => {
    if (oldAllowed === undefined) {
      delete process.env.OPENAI_COMPATIBLE_GATEWAY_BASE_URLS;
    } else {
      process.env.OPENAI_COMPATIBLE_GATEWAY_BASE_URLS = oldAllowed;
    }
  });

  it("allows approved provider bases by default", () => {
    delete process.env.OPENAI_COMPATIBLE_GATEWAY_BASE_URLS;
    expect(getAllowedGatewayBaseUrls()).toContain(
      "https://integrate.api.nvidia.com/v1",
    );
    expect(resolveGatewayTarget(
      "https://integrate.api.nvidia.com/v1/",
      "models",
      "GET",
    )).toBe("https://integrate.api.nvidia.com/v1/models");
    expect(getAllowedGatewayBaseUrls()).toContain(
      "https://openrouter.ai/api/v1",
    );
    expect(resolveGatewayTarget(
      "https://openrouter.ai/api/v1/",
      "chat/completions",
      "POST",
    )).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(getAllowedGatewayBaseUrls()).toContain(
      "https://api.cerebras.ai/v1",
    );
    expect(resolveGatewayTarget(
      "https://api.cerebras.ai/v1/",
      "models",
      "GET",
    )).toBe("https://api.cerebras.ai/v1/models");
    expect(getAllowedGatewayBaseUrls()).toContain(
      "https://ai.j3soon.com/v1",
    );
    expect(resolveGatewayTarget(
      "https://ai.j3soon.com/v1/",
      "chat/completions",
      "POST",
    )).toBe("https://ai.j3soon.com/v1/chat/completions");
  });

  it("allows only explicitly configured HTTPS bases", () => {
    process.env.OPENAI_COMPATIBLE_GATEWAY_BASE_URLS =
      "https://llm.example.org/v1, https://other.example.org/openai/v1/";
    expect(resolveGatewayTarget(
      "https://other.example.org/openai/v1",
      "/chat/completions/",
      "POST",
    )).toBe("https://other.example.org/openai/v1/chat/completions");
    expect(() => resolveGatewayTarget(
      "https://integrate.api.nvidia.com/v1",
      "models",
      "GET",
    )).toThrow("not allowed");
  });

  it.each([
    "http://integrate.api.nvidia.com/v1",
    "https://127.0.0.1/v1",
    "https://[::1]/v1",
    "https://localhost/v1",
    "https://user:pass@integrate.api.nvidia.com/v1",
    "https://integrate.api.nvidia.com:8443/v1",
    "https://integrate.api.nvidia.com/v1?target=metadata",
  ])("rejects unsafe base URL %s", (baseUrl) => {
    process.env.OPENAI_COMPATIBLE_GATEWAY_BASE_URLS = baseUrl;
    expect(() => getAllowedGatewayBaseUrls()).toThrow();
  });

  it("rejects arbitrary paths and method mismatches", () => {
    expect(() => resolveGatewayTarget(
      "https://integrate.api.nvidia.com/v1",
      "responses",
      "POST",
    )).toThrow("Unsupported");
    expect(() => resolveGatewayTarget(
      "https://integrate.api.nvidia.com/v1",
      "chat/completions",
      "GET",
    )).toThrow("method");
  });
});

import {parseList} from "../../utils/parser";
import {isIP} from "node:net";

const DEFAULT_BASE_URLS = [
  "https://integrate.api.nvidia.com/v1",
  "https://openrouter.ai/api/v1",
  "https://api.cerebras.ai/v1",
  "https://ai.j3soon.com/v1",
];

export type GatewayEndpointPath = "models" | "chat/completions";

const REQUEST_METHODS: Record<GatewayEndpointPath, "GET" | "POST"> = {
  "models": "GET",
  "chat/completions": "POST",
};

const normalizeBaseUrl = (value: string): string => {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Invalid upstream Base URL");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Gateway upstream must use HTTPS");
  }
  if (parsed.port && parsed.port !== "443") {
    throw new Error("Gateway upstream must use HTTPS port 443");
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(hostname) !== 0 || hostname === "localhost") {
    throw new Error("Gateway upstream must use an approved public hostname");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      "Upstream Base URL cannot contain credentials or parameters",
    );
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/+$/, "");
};

export const getAllowedGatewayBaseUrls = (): Set<string> => {
  const configured = parseList(
    process.env.OPENAI_COMPATIBLE_GATEWAY_BASE_URLS,
  );
  return new Set((configured.length > 0 ? configured : DEFAULT_BASE_URLS)
    .map(normalizeBaseUrl));
};

export const resolveGatewayTarget = (
  rawBaseUrl: string | undefined,
  rawPath: string | undefined,
  method: string,
): string => {
  if (!rawBaseUrl) {
    throw new Error("Upstream Base URL is required");
  }
  const baseUrl = normalizeBaseUrl(rawBaseUrl);
  if (!getAllowedGatewayBaseUrls().has(baseUrl)) {
    throw new Error("Upstream endpoint is not allowed by this gateway");
  }

  const endpointPath = rawPath?.replace(/^\/+|\/+$/g, "") as
    GatewayEndpointPath | undefined;
  if (!endpointPath || !(endpointPath in REQUEST_METHODS)) {
    throw new Error("Unsupported upstream API path");
  }
  if (REQUEST_METHODS[endpointPath] !== method.toUpperCase()) {
    throw new Error("HTTP method does not match the upstream API path");
  }

  return `${baseUrl}/${endpointPath}`;
};

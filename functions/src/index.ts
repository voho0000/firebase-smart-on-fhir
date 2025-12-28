import * as functions from "firebase-functions";
import {setGlobalOptions} from "firebase-functions/v2";
import {onRequest} from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import axios, {isAxiosError, type AxiosError} from "axios";
import Busboy from "busboy";
import cors from "cors";
import FormData from "form-data";
import {PassThrough} from "stream";
import type {Request, Response} from "express";

setGlobalOptions({
  maxInstances: 10,
  secrets: ["OPENAI_API_KEY", "GEMINI_API_KEY"],
});

type RuntimeConfig = {
  openai?: {key?: string; base_url?: string};
  proxy?: {origins?: string; client_keys?: string};
  gemini?: {
    key?: string;
    base_url?: string;
    default_model?: string;
  };
};

type RequestWithRawBody = Request & {rawBody?: Buffer};
type UploadedFileInfo = {
  filename?: string;
  encoding?: string;
  mimeType?: string;
};

let loggedConfigFallback = false;
let loggedMissingOpenAiKey = false;
let loggedMissingGeminiKey = false;

const loadRuntimeConfig = (): RuntimeConfig => {
  try {
    const config = (functions as unknown as {
      config?: () => RuntimeConfig;
    }).config;

    if (config) {
      return config() ?? {};
    }
  } catch (error) {
    if (!loggedConfigFallback) {
      logger.debug("functions.config() unavailable, falling back to env", {
        message: error instanceof Error ? error.message : String(error),
      });
      loggedConfigFallback = true;
    }
  }

  return {};
};

const parseList = (value?: string): string[] =>
  value ?
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean) :
    [];

const getRuntimeConfig = (): RuntimeConfig => {
  const runtime = loadRuntimeConfig();
  const openai = runtime.openai ?? {};
  const proxy = runtime.proxy ?? {};
  const gemini = runtime.gemini ?? {};

  const mergedOpenAi = {
    key: openai.key ?? process.env.OPENAI_KEY ?? process.env.OPENAI_API_KEY,
    base_url: openai.base_url ?? process.env.OPENAI_BASE_URL,
  } as RuntimeConfig["openai"];

  const mergedProxy = {
    origins:
      proxy.origins ??
      process.env.PROXY_ORIGINS ??
      process.env.ALLOWED_ORIGINS,
    client_keys:
      proxy.client_keys ??
      process.env.PROXY_CLIENT_KEYS ??
      process.env.CLIENT_KEYS,
  } as RuntimeConfig["proxy"];

  const mergedGemini = {
    key: gemini.key ?? process.env.GEMINI_API_KEY ?? process.env.GEMINI_KEY,
    base_url: gemini.base_url ?? process.env.GEMINI_BASE_URL,
    default_model:
      gemini.default_model ??
      process.env.GEMINI_DEFAULT_MODEL ??
      "gemini-3-flash-preview",
  } as RuntimeConfig["gemini"];

  return {
    openai: mergedOpenAi,
    proxy: mergedProxy,
    gemini: mergedGemini,
  };
};

const getAllowedOrigins = (): string[] =>
  parseList(getRuntimeConfig().proxy?.origins ?? process.env.ALLOWED_ORIGINS);

const getClientKeys = (): string[] =>
  parseList(getRuntimeConfig().proxy?.client_keys ?? process.env.CLIENT_KEYS);

const allowedModelIds = new Set<string>(["gpt-5.1", "gpt-5-mini"]);

const getOpenAiBaseUrl = (): string =>
  getRuntimeConfig().openai?.base_url ??
  process.env.OPENAI_BASE_URL ??
  "https://api.openai.com/v1";

const corsHandler = cors({
  origin: (
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void,
  ) => {
    const allowedOrigins = getAllowedOrigins();
    if (!origin) {
      callback(null, true);
      return;
    }

    if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }

    logger.warn("Blocked CORS origin", {origin});
    callback(new Error("Not allowed by CORS"));
  },
  methods: ["POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-proxy-key"],
});

type Handler = (req: Request, res: Response) => Promise<void> | void;

const withCorsAndErrorHandling =
  (handler: Handler) =>
    (req: Request, res: Response): void => {
      corsHandler(req, res, async (corsError: Error | null) => {
        if (corsError) {
          logger.warn("CORS request rejected", {message: corsError.message});
          res.status(403).json({error: corsError.message});
          return;
        }

        if (req.method === "OPTIONS") {
          res.status(204).send("");
          return;
        }

        try {
          await handler(req, res);
        } catch (error) {
          handleError(error, res);
        }
      });
    };

const getOpenAiApiKey = (): string | undefined => {
  const runtime = getRuntimeConfig();
  const key =
    runtime.openai?.key ||
    process.env.OPENAI_API_KEY ||
    process.env.OPENAI_KEY;

  if (!key && !loggedMissingOpenAiKey) {
    logger.error("OpenAI API key unavailable", {
      hasRuntimeKey: Boolean(runtime.openai?.key),
      hasEnvOpenAiApiKey: Boolean(process.env.OPENAI_API_KEY),
      hasEnvOpenAiKey: Boolean(process.env.OPENAI_KEY),
    });
    loggedMissingOpenAiKey = true;
  }

  return key;
};

const getGeminiApiKey = (): string | undefined => {
  const runtime = getRuntimeConfig();
  const key = runtime.gemini?.key;

  if (!key && !loggedMissingGeminiKey) {
    logger.error("Gemini API key unavailable", {
      hasRuntimeKey: Boolean(runtime.gemini?.key),
      hasEnvGeminiApiKey: Boolean(process.env.GEMINI_API_KEY),
      hasEnvGeminiKey: Boolean(process.env.GEMINI_KEY),
    });
    loggedMissingGeminiKey = true;
  }

  return key;
};

const getGeminiBaseUrl = (): string =>
  getRuntimeConfig().gemini?.base_url ??
  process.env.GEMINI_BASE_URL ??
  "https://generativelanguage.googleapis.com/v1beta";

const getGeminiDefaultModel = (): string =>
  getRuntimeConfig().gemini?.default_model ??
  process.env.GEMINI_DEFAULT_MODEL ??
  "gemini-3.0-flash";

const verifyClientKey = (req: Request, res: Response): boolean => {
  const clientKeys = getClientKeys();
  if (clientKeys.length === 0) {
    return true;
  }

  const providedKey = req.header("x-proxy-key")?.trim();

  if (!providedKey || !clientKeys.includes(providedKey)) {
    logger.warn("Unauthorized proxy request rejected", {
      hasKey: Boolean(providedKey),
    });
    res.status(401).json({error: "Unauthorized"});
    return false;
  }

  return true;
};

const extractOpenAiMessage = (details: unknown): string | undefined => {
  if (
    typeof details !== "object" ||
    details === null ||
    !("error" in details)
  ) {
    return undefined;
  }

  const errorInfo = (details as {error?: {message?: unknown}}).error;
  if (typeof errorInfo?.message === "string") {
    return errorInfo.message.trim();
  }

  return undefined;
};

const handleError = (error: unknown, res: Response): void => {
  if (isAxiosError(error)) {
    const axiosError = error as AxiosError;
    const status = axiosError.response?.status ?? 500;
    const details = axiosError.response?.data as unknown;
    const openAiMessage = extractOpenAiMessage(details);

    logger.error("OpenAI API error", {
      status,
      message: axiosError.message,
      details,
    });

    res
      .status(status)
      .json({error: openAiMessage ?? axiosError.message, details});
    return;
  }

  const message = error instanceof Error ? error.message : String(error);

  logger.error("Unexpected proxy error", {
    message,
    stack: error instanceof Error ? error.stack : undefined,
  });

  res.status(500).json({error: "Internal server error"});
};

type TranscriptionResponse = {
  text?: string;
  [key: string]: unknown;
};

const transcribeAudio = async (
  req: RequestWithRawBody,
  apiKey: string,
): Promise<TranscriptionResponse> =>
  new Promise((resolve, reject) => {
    // Busboy exports a factory function; disable new-cap rule for this call.
    // eslint-disable-next-line new-cap
    const busboy = Busboy({
      headers: req.headers,
      limits: {
        files: 1,
        fileSize: 25 * 1024 * 1024,
      },
    });

    const formData = new FormData();
    let prompt: string | undefined;
    let language: string | undefined;
    let model = "whisper-1";
    let fileAttached = false;

    busboy.on("field", (fieldname: string, value: string) => {
      switch (fieldname) {
      case "prompt":
        prompt = value;
        break;
      case "language":
        language = value;
        break;
      case "model":
        model = value;
        break;
      default:
        break;
      }
    });

    busboy.on(
      "file",
      (
        fieldname: string,
        file: NodeJS.ReadableStream,
        fileInfo: UploadedFileInfo,
      ) => {
        if (fieldname !== "file") {
          file.resume();
          return;
        }

        fileAttached = true;

        const passThrough = new PassThrough();

        formData.append("file", passThrough, {
          filename: fileInfo.filename ?? "audio.webm",
          contentType: fileInfo.mimeType,
        });

        file.on("limit", () => {
          reject(new Error("Uploaded file exceeds 25MB limit"));
        });

        file.pipe(passThrough);
      },
    );

    busboy.on("finish", async () => {
      if (!fileAttached) {
        reject(new Error("Missing audio file"));
        return;
      }

      formData.append("model", model || "whisper-1");

      if (prompt) {
        formData.append("prompt", prompt);
      }

      if (language) {
        formData.append("language", language);
      }

      try {
        const response = await axios.post(
          `${getOpenAiBaseUrl()}/audio/transcriptions`,
          formData,
          {
            headers: {
              ...formData.getHeaders(),
              Authorization: `Bearer ${apiKey}`,
            },
            maxBodyLength: Infinity,
          },
        );

        resolve(response.data as TranscriptionResponse);
      } catch (error) {
        reject(error);
      }
    });

    busboy.on("error", reject);

    if (req.rawBody) {
      busboy.end(req.rawBody);
    } else {
      req.pipe(busboy);
    }
  });

const buildMessages = (
  payload: Record<string, unknown>,
): unknown[] | undefined => {
  const messages = payload["messages"];

  if (Array.isArray(messages)) {
    return messages;
  }

  const inputTextRaw = payload["inputText"];
  const promptContentRaw = payload["promptContent"];
  const systemPromptRaw = payload["systemPrompt"];

  const inputText = typeof inputTextRaw === "string" ?
    (inputTextRaw as string) :
    "";
  const promptContent = typeof promptContentRaw === "string" ?
    (promptContentRaw as string) :
    "";
  const systemMessage = typeof systemPromptRaw === "string" ?
    (systemPromptRaw as string) :
    "You are a helpful assistant.";

  if (!inputText && !promptContent) {
    return undefined;
  }

  const userContent = [promptContent, inputText]
    .filter(Boolean)
    .join(" ")
    .trim();

  return [
    {role: "system", content: systemMessage},
    {role: "user", content: userContent},
  ];
};

const sanitizeChatPayload = (
  payload: Record<string, unknown>,
  messages: unknown[],
): Record<string, unknown> => {
  const allowedKeys = [
    "model",
    "temperature",
    "top_p",
    "n",
    "max_tokens",
    "stop",
    "presence_penalty",
    "frequency_penalty",
    "logit_bias",
    "user",
    "response_format",
    "tools",
    "tool_choice",
    "functions",
    "function_call",
    "seed",
  ];

  const requestedModel =
    typeof payload["model"] === "string" ? payload["model"] : undefined;

  const sanitized: Record<string, unknown> = {messages};

  for (const key of allowedKeys) {
    if (payload[key] !== undefined) {
      sanitized[key] = payload[key];
    }
  }

  if (requestedModel && allowedModelIds.has(requestedModel)) {
    sanitized.model = requestedModel;
  }

  if (!sanitized.model) {
    sanitized.model = "gpt-5.1";
  }

  if (sanitized.temperature === undefined) {
    sanitized.temperature = 0.5;
  }

  return sanitized;
};

const parseJsonBody = (req: Request): Record<string, unknown> => {
  if (!req.body) {
    return {};
  }

  if (typeof req.body === "object") {
    return req.body as Record<string, unknown>;
  }

  if (typeof req.body === "string" && req.body.length > 0) {
    try {
      return JSON.parse(req.body) as Record<string, unknown>;
    } catch (error) {
      throw new Error("Invalid JSON payload");
    }
  }

  return {};
};

type ChatMessage = {
  role: string;
  content: string;
};

const toPlainText = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    const texts = value
      .map((item) => {
        if (
          typeof item === "object" &&
          item !== null &&
          "text" in item &&
          typeof (item as {text?: unknown}).text === "string"
        ) {
          return (item as {text: string}).text;
        }

        return undefined;
      })
      .filter(Boolean) as string[];

    if (texts.length > 0) {
      return texts.join(" ");
    }
  }

  if (
    typeof value === "object" &&
    value !== null &&
    "text" in value &&
    typeof (value as {text?: unknown}).text === "string"
  ) {
    return (value as {text: string}).text;
  }

  return undefined;
};

const normalizeChatMessages = (messages: unknown[]): ChatMessage[] =>
  messages
    .map((message) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        typeof (message as {role?: unknown}).role === "string"
      ) {
        const role = (message as {role: string}).role;
        const content = toPlainText((message as {content?: unknown}).content);

        if (typeof content === "string" && content.trim().length > 0) {
          return {role, content: content.trim()};
        }
      }

      return undefined;
    })
    .filter(Boolean) as ChatMessage[];

const buildGeminiGenerationConfig = (
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined => {
  const generationConfig: Record<string, unknown> = {};

  if (typeof payload["temperature"] === "number") {
    generationConfig.temperature = payload["temperature"];
  }

  if (typeof payload["top_p"] === "number") {
    generationConfig.topP = payload["top_p"];
  }

  if (typeof payload["top_k"] === "number") {
    generationConfig.topK = payload["top_k"];
  }

  if (typeof payload["max_output_tokens"] === "number") {
    generationConfig.maxOutputTokens = payload["max_output_tokens"];
  } else if (typeof payload["max_tokens"] === "number") {
    generationConfig.maxOutputTokens = payload["max_tokens"];
  }

  return Object.keys(generationConfig).length > 0 ?
    generationConfig :
    undefined;
};

const toNumber = (value: unknown): number | undefined => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
};

const extractRequestedTemperature = (
  payload: Record<string, unknown>,
  generationConfig?: Record<string, unknown>,
): number | undefined => {
  const directTemperature = toNumber(payload["temperature"]);

  if (typeof directTemperature === "number") {
    return directTemperature;
  }

  const payloadGenerationConfigRaw =
    typeof payload["generationConfig"] === "object" &&
    payload["generationConfig"] !== null ?
      payload["generationConfig"] :
      typeof payload["generation_config"] === "object" &&
          payload["generation_config"] !== null ?
        payload["generation_config"] :
        undefined;

  const sources = [generationConfig, payloadGenerationConfigRaw].filter(
    Boolean,
  ) as Record<string, unknown>[];

  for (const source of sources) {
    const candidate = toNumber(source["temperature"]);

    if (typeof candidate === "number") {
      return candidate;
    }
  }

  return undefined;
};

const extractGeminiText = (data: unknown): string | undefined => {
  if (!data || typeof data !== "object") {
    return undefined;
  }

  const candidates = (data as {candidates?: unknown[]}).candidates;

  if (!Array.isArray(candidates)) {
    return undefined;
  }

  const texts: string[] = [];

  for (const candidate of candidates) {
    if (
      candidate &&
      typeof candidate === "object" &&
      "content" in candidate
    ) {
      const content = (candidate as {content?: unknown}).content;

      if (
        content &&
        typeof content === "object" &&
        "parts" in content &&
        Array.isArray((content as {parts?: unknown}).parts)
      ) {
        const parts = (content as {parts: unknown[]}).parts;

        for (const part of parts) {
          if (
            part &&
            typeof part === "object" &&
            "text" in part &&
            typeof (part as {text?: unknown}).text === "string"
          ) {
            texts.push((part as {text: string}).text);
          }
        }
      }
    }
  }

  const combined = texts.join("\n").trim();
  return combined.length > 0 ? combined : undefined;
};

export const proxyWhisper = onRequest(
  {timeoutSeconds: 540, memory: "2GiB"},
  withCorsAndErrorHandling(async (req, res) => {
    if (req.method !== "POST") {
      res.set("Allow", "POST, OPTIONS");
      res.status(405).send("Method not allowed");
      return;
    }

    if (!verifyClientKey(req, res)) {
      return;
    }

    const apiKey = getOpenAiApiKey();

    if (!apiKey) {
      res
        .status(500)
        .json({error: "Server misconfiguration: OpenAI key missing"});
      return;
    }

    const transcription = await transcribeAudio(
      req as RequestWithRawBody,
      apiKey,
    );

    const transcript =
      typeof transcription.text === "string" ? transcription.text : undefined;

    res.status(200).json({
      transcript,
      openAiResponse: transcription,
    });
  }),
);

export const proxyGeminiChat = onRequest(
  {timeoutSeconds: 300, memory: "1GiB"},
  withCorsAndErrorHandling(async (req, res) => {
    if (req.method !== "POST") {
      res.set("Allow", "POST, OPTIONS");
      res.status(405).send("Method not allowed");
      return;
    }

    if (!verifyClientKey(req, res)) {
      return;
    }

    const apiKey = getGeminiApiKey();

    if (!apiKey) {
      res
        .status(500)
        .json({error: "Server misconfiguration: Gemini key missing"});
      return;
    }

    const payload = parseJsonBody(req);
    const rawMessages = buildMessages(payload);

    if (!rawMessages) {
      res
        .status(400)
        .json({error: "Request must include messages or inputText"});
      return;
    }

    const normalizedMessages = normalizeChatMessages(rawMessages);

    if (normalizedMessages.length === 0) {
      res.status(400).json({error: "No usable messages found"});
      return;
    }

    const systemMessages = normalizedMessages.filter(
      (message) => message.role === "system",
    );
    const conversationMessages = normalizedMessages.filter(
      (message) => message.role !== "system",
    );

    const contents = conversationMessages.map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{text: message.content}],
    }));

    if (contents.length === 0) {
      res.status(400).json({error: "No user or assistant messages found"});
      return;
    }

    let generationConfig = buildGeminiGenerationConfig(payload);
    const safetySettings = payload["safetySettings"];
    const tools = payload["tools"];
    const toolConfig = payload["toolConfig"] ?? payload["tool_config"];
    const responseSchema = payload["responseSchema"];
    const responseMimeType = payload["responseMimeType"];

    const model =
      typeof payload["model"] === "string" && payload["model"].trim() ?
        payload["model"] as string :
        getGeminiDefaultModel();

    const requestedTemperature = extractRequestedTemperature(
      payload,
      generationConfig,
    );

    const isFlash = model.toLowerCase().includes("flash");
    logger.info(
      `Gemini request: model=${model}, ` +
      `requestedTemperature=${requestedTemperature}, isFlash=${isFlash}`,
    );

    if (
      typeof requestedTemperature === "number" &&
      requestedTemperature !== 1 &&
      isFlash
    ) {
      logger.info(
        `Overriding temperature from ${requestedTemperature} to 1 ` +
        "for Flash model",
      );
      generationConfig = {
        ...(generationConfig ?? {}),
        temperature: 1,
      };
    }

    logger.info(
      `Final generationConfig: ${JSON.stringify(generationConfig)}`,
    );

    const requestBody: Record<string, unknown> = {contents};

    if (systemMessages.length > 0) {
      requestBody.systemInstruction = {
        role: "system",
        parts: [{
          text: systemMessages.map((message) => message.content).join("\n"),
        }],
      };
    }

    if (generationConfig) {
      requestBody.generationConfig = generationConfig;
    }

    if (Array.isArray(safetySettings)) {
      requestBody.safetySettings = safetySettings;
    }

    if (Array.isArray(tools)) {
      requestBody.tools = tools;
    }

    if (toolConfig !== undefined) {
      requestBody.toolConfig = toolConfig;
    }

    if (responseSchema !== undefined) {
      requestBody.responseSchema = responseSchema;
    }

    if (typeof responseMimeType === "string") {
      requestBody.responseMimeType = responseMimeType;
    }

    const geminiResponse = await axios.post(
      `${getGeminiBaseUrl()}/models/${model}:generateContent`,
      requestBody,
      {
        params: {key: apiKey},
        headers: {"Content-Type": "application/json"},
      },
    );

    const message = extractGeminiText(geminiResponse.data);

    res.status(200).json({
      message,
      geminiResponse: geminiResponse.data,
    });
  }),
);

export const proxyChatCompletion = onRequest(
  {timeoutSeconds: 300, memory: "1GiB"},
  withCorsAndErrorHandling(async (req, res) => {
    if (req.method !== "POST") {
      res.set("Allow", "POST, OPTIONS");
      res.status(405).send("Method not allowed");
      return;
    }

    if (!verifyClientKey(req, res)) {
      return;
    }

    const apiKey = getOpenAiApiKey();

    if (!apiKey) {
      res
        .status(500)
        .json({error: "Server misconfiguration: OpenAI key missing"});
      return;
    }

    const payload = parseJsonBody(req);

    if (payload["stream"] === true) {
      res.status(400).json({error: "Streaming responses are not supported"});
      return;
    }

    const messages = buildMessages(payload);

    if (!messages) {
      res
        .status(400)
        .json({error: "Request must include messages or inputText"});
      return;
    }

    let chatRequest = sanitizeChatPayload(payload, messages);

    const model = chatRequest.model || "gpt-5.1";
    const requestedTemp = chatRequest.temperature;

    if (
      typeof requestedTemp === "number" &&
      requestedTemp !== 1 &&
      model === "gpt-5-mini"
    ) {
      logger.info(
        `Overriding temperature from ${requestedTemp} to 1 ` +
        "for gpt-5-mini model",
      );
      chatRequest = {
        ...chatRequest,
        temperature: 1,
      };
    }

    const response = await axios.post(
      `${getOpenAiBaseUrl()}/chat/completions`,
      chatRequest,
      {
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      },
    );

    const message =
      response.data?.choices?.[0]?.message?.content?.trim() ?? null;

    res.status(200).json({
      message,
      openAiResponse: response.data,
    });
  }),
);

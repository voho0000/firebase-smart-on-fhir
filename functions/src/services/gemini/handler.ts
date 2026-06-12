import type {Request, Response} from "express";
import axios from "axios";
import * as logger from "firebase-functions/logger";
import {
  getGeminiApiKey,
  getGeminiBaseUrl,
  getGeminiDefaultModel,
} from "../../config/runtime";
import {verifyClientKey, verifyFirebaseIdToken} from "../../middleware/auth";
import {checkAndConsumeQuota} from "../../middleware/quota";
import {
  parseJsonBody,
  buildMessages,
  normalizeChatMessages,
} from "../../utils/parser";
import {
  buildGeminiGenerationConfig,
  extractRequestedTemperature,
  extractGeminiText,
  transformMessagesForGemini,
} from "./utils";
import {handleGeminiStreaming} from "./streaming";
import {isNativeGeminiBody, handleGeminiPassthrough} from "./passthrough";

export const handleGeminiChat = async (
  req: Request,
  res: Response,
): Promise<void> => {
  if (req.method !== "POST") {
    res.set("Allow", "POST, OPTIONS");
    res.status(405).send("Method not allowed");
    return;
  }

  if (!verifyClientKey(req, res)) {
    return;
  }

  // Owner-funded proxy: signed-in users only, metered per uid (audit A6)
  const uid = await verifyFirebaseIdToken(req, res);
  if (!uid) {
    return;
  }
  if (!(await checkAndConsumeQuota(uid, res))) {
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

  // Native AI-SDK body (contents[] with tool parts) → forward to Google
  // verbatim so multi-step tool loops survive (the legacy flatten below
  // drops functionCall/functionResponse parts).
  if (isNativeGeminiBody(payload)) {
    await handleGeminiPassthrough(payload, res);
    return;
  }

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

  const contents = transformMessagesForGemini(normalizedMessages);

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

  // Proxy tier: only the default (cheapest) Gemini runs on the owner's key.
  // Pre-existing hole: any model id in the payload was forwarded verbatim,
  // so proxy users could bill pro-tier models to the server key.
  const requestedModel =
    typeof payload["model"] === "string" && payload["model"].trim() ?
      payload["model"] as string :
      undefined;
  const model =
    requestedModel && requestedModel === getGeminiDefaultModel() ?
      requestedModel :
      getGeminiDefaultModel();
  if (requestedModel && requestedModel !== model) {
    logger.info(`Forcing Gemini model ${requestedModel} -> ${model}`);
  }

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

  const isStreaming = payload["stream"] === true;

  if (isStreaming) {
    await handleGeminiStreaming(
      model,
      normalizedMessages,
      generationConfig,
      tools,
      toolConfig,
      safetySettings,
      responseSchema,
      responseMimeType,
      res,
    );
  } else {
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
  }
};

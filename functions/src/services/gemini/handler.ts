import type {Request, Response} from "express";
import axios from "axios";
import * as logger from "firebase-functions/logger";
import {
  getGeminiApiKey,
  getGeminiBaseUrl,
  getGeminiDefaultModel,
} from "../../config/runtime";
import {verifyClientKey} from "../../middleware/auth";
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

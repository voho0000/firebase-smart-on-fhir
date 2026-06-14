import type {Request, Response} from "express";
import axios from "axios";
import * as logger from "firebase-functions/logger";
import {getOpenAiApiKey, getOpenAiBaseUrl} from "../../config/runtime";
import {verifyClientKey, verifyFirebaseIdToken} from "../../middleware/auth";
import {checkAndConsumeQuota} from "../../middleware/quota";
import {
  parseJsonBody,
  buildMessages,
  normalizeChatMessages,
} from "../../utils/parser";
import {sanitizeChatPayload, transformMessagesForOpenAI} from "./utils";
import {isNativeOpenAiBody, handleOpenAiPassthrough} from "./passthrough";
import {handleOpenAIStreaming} from "./streaming";

export const handleChatCompletion = async (
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

  // Owner-funded proxy: signed-in (or anonymous) users, metered per uid (A6)
  const auth = await verifyFirebaseIdToken(req, res);
  if (!auth) {
    return;
  }
  if (!(await checkAndConsumeQuota(auth.uid, res, "chat", auth.isAnonymous))) {
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

  // Native AI-SDK body (tool_calls / role:"tool" / multimodal content) →
  // forward verbatim so multi-step tool loops survive (the legacy normalize
  // path below strips tool_calls and tool_call_id, 400ing OpenAI).
  if (isNativeOpenAiBody(payload)) {
    await handleOpenAiPassthrough(payload, res);
    return;
  }

  const messages = buildMessages(payload);

  if (!messages) {
    res
      .status(400)
      .json({error: "Request must include messages or inputText"});
    return;
  }

  const normalizedMessages = normalizeChatMessages(messages);
  const transformedMessages = transformMessagesForOpenAI(normalizedMessages);
  let chatRequest = sanitizeChatPayload(payload, transformedMessages);

  const model = chatRequest.model || "gpt-5.4-nano";
  const requestedTemp = chatRequest.temperature;

  if (
    typeof requestedTemp === "number" &&
    requestedTemp !== 1 &&
    typeof model === "string" &&
    model.startsWith("gpt-5")
  ) {
    logger.info(
      `Overriding temperature from ${requestedTemp} to 1 ` +
      `for ${model}`,
    );
    chatRequest = {
      ...chatRequest,
      temperature: 1,
    };
  }

  const isStreaming = payload["stream"] === true;

  if (isStreaming) {
    await handleOpenAIStreaming(
      model as string,
      normalizedMessages,
      chatRequest,
      res,
    );
  } else {
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
  }
};

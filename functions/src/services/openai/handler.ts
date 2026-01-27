import type {Request, Response} from "express";
import axios from "axios";
import * as logger from "firebase-functions/logger";
import {getOpenAiApiKey, getOpenAiBaseUrl} from "../../config/runtime";
import {verifyClientKey} from "../../middleware/auth";
import {
  parseJsonBody,
  buildMessages,
  normalizeChatMessages,
} from "../../utils/parser";
import {sanitizeChatPayload, transformMessagesForOpenAI} from "./utils";
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

  const apiKey = getOpenAiApiKey();

  if (!apiKey) {
    res
      .status(500)
      .json({error: "Server misconfiguration: OpenAI key missing"});
    return;
  }

  const payload = parseJsonBody(req);
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

  const model = chatRequest.model || "gpt-5-mini";
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

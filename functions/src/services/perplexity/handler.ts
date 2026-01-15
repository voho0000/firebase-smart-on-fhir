import type {Request, Response} from "express";
import axios, {isAxiosError} from "axios";
import * as logger from "firebase-functions/logger";
import {getPerplexityApiKey} from "../../config/runtime";
import {verifyClientKey} from "../../middleware/auth";
import {parseJsonBody} from "../../utils/parser";
import {buildPerplexityPayload} from "./utils";
import type {
  PerplexitySearchRequest,
  PerplexitySearchResponse,
  PerplexityApiResponse,
} from "./types";

const PERPLEXITY_API_URL = "https://api.perplexity.ai/chat/completions";

export const handlePerplexitySearch = async (
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

  const payload = parseJsonBody(req) as unknown as PerplexitySearchRequest;
  const {query} = payload;

  if (!query) {
    res.status(400).json({
      success: false,
      content: "",
      error: "Query is required",
    });
    return;
  }

  const apiKey = getPerplexityApiKey();
  if (!apiKey) {
    res.status(500).json({
      success: false,
      content: "",
      error: "Server API key not configured",
    });
    return;
  }

  try {
    const perplexityPayload = buildPerplexityPayload(payload);

    logger.info("Calling Perplexity API", {
      model: perplexityPayload.model,
      queryLength: query.length,
    });

    const response = await axios.post<PerplexityApiResponse>(
      PERPLEXITY_API_URL,
      perplexityPayload,
      {
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      },
    );

    const content = response.data?.choices?.[0]?.message?.content || "";
    const citations = response.data?.citations || [];

    const result: PerplexitySearchResponse = {
      success: true,
      content,
      citations,
    };

    logger.info("Perplexity API call successful", {
      contentLength: content.length,
      citationsCount: citations.length,
    });

    res.status(200).json(result);
  } catch (error) {
    if (isAxiosError(error)) {
      const status = error.response?.status || 500;
      const errorMessage =
        error.response?.data?.error?.message ||
        error.response?.statusText ||
        error.message;

      logger.error("Perplexity API error", {
        status,
        message: errorMessage,
        data: error.response?.data,
      });

      res.status(status).json({
        success: false,
        content: "",
        error: `Perplexity API error: ${errorMessage}`,
      });
    } else {
      const errorMsg =
        error instanceof Error ? error.message : "Unknown error occurred";

      logger.error("Unexpected error in Perplexity search", {
        error: errorMsg,
      });

      res.status(500).json({
        success: false,
        content: "",
        error: errorMsg,
      });
    }
  }
};

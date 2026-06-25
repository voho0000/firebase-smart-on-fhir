import type {Request, Response} from "express";
import axios, {isAxiosError} from "axios";
import * as logger from "firebase-functions/logger";
import {getPerplexityApiKey} from "../../config/runtime";
import {verifyClientKey, verifyFirebaseIdToken} from "../../middleware/auth";
import {checkAndConsumeQuota} from "../../middleware/quota";
import {parseJsonBody} from "../../utils/parser";
import {buildPerplexityPayload, isAuthoritativeUrl} from "./utils";
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

  // Owner-funded proxy: signed-in (or anonymous) users, metered per uid (A6)
  const auth = await verifyFirebaseIdToken(req, res);
  if (!auth) {
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

  // BYO key: when the caller supplies their own Perplexity key we authorize the
  // upstream call with THEIR key (used transiently here — never logged or
  // stored) and skip the owner-funded daily quota. With no user key we fall
  // back to the server key and meter the call against the per-uid quota (A6).
  const userKey =
    typeof payload.perplexityKey === "string" ?
      payload.perplexityKey.trim() :
      "";
  const usingUserKey = userKey.length > 0;

  if (!usingUserKey) {
    if (!(await checkAndConsumeQuota(
      auth.uid, res, "perplexity", auth.isAnonymous))) {
      return;
    }
  }

  const apiKey = usingUserKey ? userKey : getPerplexityApiKey();
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
      usingUserKey,
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

    const content =
      response.data?.choices?.[0]?.message?.content || "";

    // Perplexity is migrating source URLs from the top-level `citations` array
    // (frequently empty now) to `search_results`. Merge both (dedup, preserve
    // order) so citation links survive whichever field is populated.
    const directCitations = Array.isArray(response.data?.citations) ?
      response.data.citations :
      [];
    const searchResultUrls = Array.isArray(response.data?.search_results) ?
      response.data.search_results
        .map((r) => r?.url)
        .filter(
          (u): u is string => typeof u === "string" && u.length > 0,
        ) :
      [];
    // Drop any non-authoritative URLs that slipped past the search denylist so
    // the rendered Sources list stays clinically credible.
    const citations = [...new Set([...directCitations, ...searchResultUrls])]
      .filter(isAuthoritativeUrl);

    const result: PerplexitySearchResponse = {
      success: true,
      content,
      citations,
    };

    logger.info("Perplexity API call successful", {
      contentLength: content.length,
      citationsCount: citations.length,
      rawCitationsCount: directCitations.length,
      searchResultsCount: searchResultUrls.length,
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

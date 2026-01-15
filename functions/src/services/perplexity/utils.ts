import type {PerplexitySearchRequest} from "./types";

export const getPerplexityModel = (
  searchDepth: "basic" | "advanced" = "basic",
): string => {
  return searchDepth === "advanced" ? "sonar-pro" : "sonar";
};

export const buildPerplexityPayload = (
  request: PerplexitySearchRequest,
) => {
  const model = getPerplexityModel(request.searchDepth);
  const searchDomainFilter = request.searchDomainFilter || [
    "pubmed.ncbi.nlm.nih.gov",
    "nih.gov",
    "who.int",
    "uptodate.com",
  ];

  const systemContent =
    "You are a medical literature search assistant. " +
    "Provide accurate, evidence-based medical information with " +
    "citations from peer-reviewed sources, clinical guidelines, " +
    "and authoritative medical resources. Always cite your sources " +
    "with links when available.";

  return {
    model,
    messages: [
      {
        role: "system",
        content: systemContent,
      },
      {
        role: "user",
        content: request.query,
      },
    ],
    max_tokens: request.maxTokens || 1500,
    temperature: request.temperature ?? 0.2,
    top_p: request.topP ?? 0.9,
    search_domain_filter: searchDomainFilter,
    return_citations: true,
    return_images: false,
    stream: false,
  };
};

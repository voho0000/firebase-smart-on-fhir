import type {PerplexitySearchRequest} from "./types";

// Obvious non-authoritative sources to keep OUT of medical literature results
// (social media, video, forums, personal-blog platforms). Used both as a
// Perplexity search-time denylist (`-domain`) and to filter the returned
// citation URLs. Stays well under Perplexity's 20-domain limit.
export const NON_AUTHORITATIVE_DOMAINS = [
  "youtube.com",
  "youtu.be",
  "reddit.com",
  "facebook.com",
  "twitter.com",
  "x.com",
  "tiktok.com",
  "instagram.com",
  "quora.com",
  "pinterest.com",
  "linkedin.com",
  "medium.com",
  "substack.com",
];

// True unless the URL's host is (a subdomain of) a non-authoritative domain.
// Unparseable URLs are kept as-is rather than silently dropped.
export const isAuthoritativeUrl = (url: string): boolean => {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return !NON_AUTHORITATIVE_DOMAINS.some(
      (d) => host === d || host.endsWith(`.${d}`),
    );
  } catch {
    return true;
  }
};

export const getPerplexityModel = (
  searchDepth: "basic" | "advanced" = "basic",
): string => {
  return searchDepth === "advanced" ? "sonar-pro" : "sonar";
};

export const buildPerplexityPayload = (
  request: PerplexitySearchRequest,
) => {
  const model = getPerplexityModel(request.searchDepth);

  const systemContent =
    "You are a medical search assistant. Provide accurate, " +
    "evidence-based medical information and cite authoritative sources " +
    "— peer-reviewed journals, clinical practice guidelines, " +
    "specialty-society pages, regulatory and health-authority sites " +
    "(e.g. FDA, EMA, TFDA, NICE, CDC, WHO), official drug labels / " +
    "package inserts, and reputable medical references. Prefer the most " +
    "authoritative and up-to-date source for each point. Always cite " +
    "your sources with links when available.";

  const payload: Record<string, unknown> = {
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
    return_citations: true,
    return_images: false,
    stream: false,
  };

  // Keep the search BROAD (no narrow allow-list, so ADA/GINA/etc. surface) but
  // exclude obviously non-authoritative domains via Perplexity's `-` denylist.
  // A caller-supplied filter (allow or deny) overrides the default.
  payload.search_domain_filter =
    request.searchDomainFilter && request.searchDomainFilter.length > 0 ?
      request.searchDomainFilter :
      NON_AUTHORITATIVE_DOMAINS.map((d) => `-${d}`);

  return payload;
};

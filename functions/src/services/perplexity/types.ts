export interface PerplexitySearchRequest {
  query: string;
  searchDepth?: "basic" | "advanced";
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  searchDomainFilter?: string[];
  /**
   * Optional caller-supplied Perplexity API key (BYO key). When present the
   * proxy bills THIS key instead of the server key and skips the owner-funded
   * daily quota. Used transiently to authorize the upstream call — never logged
   * or persisted.
   */
  perplexityKey?: string;
}

export interface PerplexitySearchResponse {
  success: boolean;
  content: string;
  citations?: string[];
  error?: string;
}

export interface PerplexityApiResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  citations?: string[];
  // Newer Sonar responses carry sources here (with the top-level `citations`
  // array often empty). Each result has at least a url + title.
  search_results?: Array<{
    title?: string;
    url?: string;
    date?: string | null;
  }>;
}

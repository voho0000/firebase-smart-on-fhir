export interface PerplexitySearchRequest {
  query: string;
  searchDepth?: "basic" | "advanced";
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  searchDomainFilter?: string[];
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
}

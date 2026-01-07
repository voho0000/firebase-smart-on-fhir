import type {Request} from "express";

export type RuntimeConfig = {
  openai?: {key?: string; base_url?: string};
  proxy?: {origins?: string; client_keys?: string};
  gemini?: {
    key?: string;
    base_url?: string;
    default_model?: string;
  };
};

export type RequestWithRawBody = Request & {rawBody?: Buffer};

export type UploadedFileInfo = {
  filename?: string;
  encoding?: string;
  mimeType?: string;
};

export type ChatMessage = {
  role: string;
  content: string;
};

import cors from "cors";
import * as logger from "firebase-functions/logger";
import {getRuntimeConfig} from "../config/runtime";
import {parseList} from "../utils/parser";

const getAllowedOrigins = (): string[] =>
  parseList(getRuntimeConfig().proxy?.origins ?? process.env.ALLOWED_ORIGINS);

export const corsHandler = cors({
  origin: (
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void,
  ) => {
    const allowedOrigins = getAllowedOrigins();
    if (!origin) {
      callback(null, true);
      return;
    }

    if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }

    logger.warn("Blocked CORS origin", {origin});
    callback(new Error("Not allowed by CORS"));
  },
  methods: ["POST", "OPTIONS"],
  // Authorization carries the Firebase ID token (audit A6) — without it here
  // the browser preflight rejects every authenticated proxy call.
  // anthropic-version / anthropic-beta are added by the @ai-sdk/anthropic
  // client on every request; omitting them made every Claude proxy call fail
  // CORS preflight ("Failed to fetch").
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "x-proxy-key",
    "x-client-key",
    "anthropic-version",
    "anthropic-beta",
  ],
});

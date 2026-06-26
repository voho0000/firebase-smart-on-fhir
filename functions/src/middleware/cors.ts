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
  // User-Agent: the AI SDK sets a custom UA (e.g. "ai-sdk/..."). Desktop
  // Chrome/Firefox treat User-Agent as a forbidden header and strip it, so it
  // never reaches the preflight — but iOS Safari/WebKit (incl. Chrome on iOS)
  // ALLOWS fetch to set it, so its preflight asks for `User-Agent` and the
  // proxy MUST allow it or every iOS proxy call fails with "Load failed".
  // (This was THE iOS-only "連線被擋下" bug.)
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "x-proxy-key",
    "x-client-key",
    "anthropic-version",
    "anthropic-beta",
    "User-Agent",
  ],
});

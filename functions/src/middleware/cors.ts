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
  allowedHeaders: ["Content-Type", "x-proxy-key"],
});

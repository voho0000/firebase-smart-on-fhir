import * as functions from "firebase-functions";
import * as logger from "firebase-functions/logger";
import type {RuntimeConfig} from "../types/common";
import {DEFAULT_GEMINI_MODEL, DEFAULT_OPENAI_BASE_URL} from "./constants";

let loggedConfigFallback = false;
let loggedMissingOpenAiKey = false;
let loggedMissingGeminiKey = false;

const loadRuntimeConfig = (): RuntimeConfig => {
  try {
    const config = (functions as unknown as {
      config?: () => RuntimeConfig;
    }).config;

    if (config) {
      return config() ?? {};
    }
  } catch (error) {
    if (!loggedConfigFallback) {
      logger.debug("functions.config() unavailable, falling back to env", {
        message: error instanceof Error ? error.message : String(error),
      });
      loggedConfigFallback = true;
    }
  }

  return {};
};

export const getRuntimeConfig = (): RuntimeConfig => {
  const runtime = loadRuntimeConfig();
  const openai = runtime.openai ?? {};
  const proxy = runtime.proxy ?? {};
  const gemini = runtime.gemini ?? {};

  const mergedOpenAi = {
    key: openai.key ?? process.env.OPENAI_KEY ?? process.env.OPENAI_API_KEY,
    base_url: openai.base_url ?? process.env.OPENAI_BASE_URL,
  } as RuntimeConfig["openai"];

  const mergedProxy = {
    origins:
      proxy.origins ??
      process.env.PROXY_ORIGINS ??
      process.env.ALLOWED_ORIGINS,
    client_keys:
      proxy.client_keys ??
      process.env.PROXY_CLIENT_KEYS ??
      process.env.CLIENT_KEYS,
  } as RuntimeConfig["proxy"];

  const mergedGemini = {
    key: gemini.key ?? process.env.GEMINI_API_KEY ?? process.env.GEMINI_KEY,
    base_url: gemini.base_url ?? process.env.GEMINI_BASE_URL,
    default_model:
      gemini.default_model ??
      process.env.GEMINI_DEFAULT_MODEL ??
      DEFAULT_GEMINI_MODEL,
  } as RuntimeConfig["gemini"];

  return {
    openai: mergedOpenAi,
    proxy: mergedProxy,
    gemini: mergedGemini,
  };
};

export const getOpenAiApiKey = (): string | undefined => {
  const runtime = getRuntimeConfig();
  const key =
    runtime.openai?.key ||
    process.env.OPENAI_API_KEY ||
    process.env.OPENAI_KEY;

  if (!key && !loggedMissingOpenAiKey) {
    logger.error("OpenAI API key unavailable", {
      hasRuntimeKey: Boolean(runtime.openai?.key),
      hasEnvOpenAiApiKey: Boolean(process.env.OPENAI_API_KEY),
      hasEnvOpenAiKey: Boolean(process.env.OPENAI_KEY),
    });
    loggedMissingOpenAiKey = true;
  }

  return key;
};

export const getGeminiApiKey = (): string | undefined => {
  const runtime = getRuntimeConfig();
  const key = runtime.gemini?.key;

  if (!key && !loggedMissingGeminiKey) {
    logger.error("Gemini API key unavailable", {
      hasRuntimeKey: Boolean(runtime.gemini?.key),
      hasEnvGeminiApiKey: Boolean(process.env.GEMINI_API_KEY),
      hasEnvGeminiKey: Boolean(process.env.GEMINI_KEY),
    });
    loggedMissingGeminiKey = true;
  }

  return key;
};

export const getOpenAiBaseUrl = (): string =>
  getRuntimeConfig().openai?.base_url ??
  process.env.OPENAI_BASE_URL ??
  DEFAULT_OPENAI_BASE_URL;

export const getGeminiBaseUrl = (): string =>
  getRuntimeConfig().gemini?.base_url ??
  process.env.GEMINI_BASE_URL ??
  "https://generativelanguage.googleapis.com/v1beta";

export const getGeminiDefaultModel = (): string =>
  getRuntimeConfig().gemini?.default_model ??
  process.env.GEMINI_DEFAULT_MODEL ??
  "gemini-3.0-flash";

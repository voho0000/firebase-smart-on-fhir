import type {Request, Response} from "express";
import {isAxiosError, type AxiosError} from "axios";
import * as logger from "firebase-functions/logger";
import {corsHandler} from "./cors";

type Handler = (req: Request, res: Response) => Promise<void> | void;

const extractOpenAiMessage = (details: unknown): string | undefined => {
  if (
    typeof details !== "object" ||
    details === null ||
    !("error" in details)
  ) {
    return undefined;
  }

  const errorInfo = (details as {error?: {message?: unknown}}).error;
  if (typeof errorInfo?.message === "string") {
    return errorInfo.message.trim();
  }

  return undefined;
};

export const handleError = (error: unknown, res: Response): void => {
  if (isAxiosError(error)) {
    const axiosError = error as AxiosError;
    const status = axiosError.response?.status ?? 500;
    const details = axiosError.response?.data as unknown;
    const openAiMessage = extractOpenAiMessage(details);

    logger.error("API error", {
      status,
      message: axiosError.message,
      details,
    });

    res
      .status(status)
      .json({error: openAiMessage ?? axiosError.message, details});
    return;
  }

  const message = error instanceof Error ? error.message : String(error);

  logger.error("Unexpected error", {
    message,
    stack: error instanceof Error ? error.stack : undefined,
  });

  res.status(500).json({error: message});
};

export const withCorsAndErrorHandling =
  (handler: Handler) =>
    (req: Request, res: Response): void => {
      corsHandler(req, res, async (corsError: Error | null) => {
        if (corsError) {
          logger.warn("CORS request rejected", {message: corsError.message});
          res.status(403).json({error: corsError.message});
          return;
        }

        if (req.method === "OPTIONS") {
          res.status(204).send("");
          return;
        }

        try {
          await handler(req, res);
        } catch (error) {
          handleError(error, res);
        }
      });
    };

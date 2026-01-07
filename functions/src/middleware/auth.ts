import type {Request, Response} from "express";
import * as logger from "firebase-functions/logger";
import {getRuntimeConfig} from "../config/runtime";
import {parseList} from "../utils/parser";

const getClientKeys = (): string[] =>
  parseList(getRuntimeConfig().proxy?.client_keys ?? process.env.CLIENT_KEYS);

export const verifyClientKey = (req: Request, res: Response): boolean => {
  const clientKeys = getClientKeys();
  if (clientKeys.length === 0) {
    return true;
  }

  const providedKey = req.header("x-proxy-key")?.trim();

  if (!providedKey || !clientKeys.includes(providedKey)) {
    logger.warn("Unauthorized proxy request rejected", {
      hasKey: Boolean(providedKey),
    });
    res.status(401).json({error: "Unauthorized"});
    return false;
  }

  return true;
};

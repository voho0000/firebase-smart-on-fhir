import type {Request, Response} from "express";
import axios from "axios";
import Busboy from "busboy";
import FormData from "form-data";
import {PassThrough} from "stream";
import {getOpenAiApiKey, getOpenAiBaseUrl} from "../../config/runtime";
import {verifyClientKey} from "../../middleware/auth";
import type {RequestWithRawBody, UploadedFileInfo} from "../../types/common";

type TranscriptionResponse = {
  text?: string;
  [key: string]: unknown;
};

const transcribeAudio = async (
  req: RequestWithRawBody,
  apiKey: string,
): Promise<TranscriptionResponse> =>
  new Promise((resolve, reject) => {
    // eslint-disable-next-line new-cap
    const busboy = Busboy({
      headers: req.headers,
      limits: {
        files: 1,
        fileSize: 25 * 1024 * 1024,
      },
    });

    const formData = new FormData();
    let prompt: string | undefined;
    let language: string | undefined;
    let model = "whisper-1";
    let fileAttached = false;

    busboy.on("field", (fieldname: string, value: string) => {
      switch (fieldname) {
      case "prompt":
        prompt = value;
        break;
      case "language":
        language = value;
        break;
      case "model":
        model = value;
        break;
      default:
        break;
      }
    });

    busboy.on(
      "file",
      (
        fieldname: string,
        file: NodeJS.ReadableStream,
        fileInfo: UploadedFileInfo,
      ) => {
        if (fieldname !== "file") {
          file.resume();
          return;
        }

        fileAttached = true;

        const passThrough = new PassThrough();

        formData.append("file", passThrough, {
          filename: fileInfo.filename ?? "audio.webm",
          contentType: fileInfo.mimeType,
        });

        file.on("limit", () => {
          reject(new Error("Uploaded file exceeds 25MB limit"));
        });

        file.pipe(passThrough);
      },
    );

    busboy.on("finish", async () => {
      if (!fileAttached) {
        reject(new Error("Missing audio file"));
        return;
      }

      formData.append("model", model || "whisper-1");

      if (prompt) {
        formData.append("prompt", prompt);
      }

      if (language) {
        formData.append("language", language);
      }

      try {
        const response = await axios.post(
          `${getOpenAiBaseUrl()}/audio/transcriptions`,
          formData,
          {
            headers: {
              ...formData.getHeaders(),
              Authorization: `Bearer ${apiKey}`,
            },
            maxBodyLength: Infinity,
          },
        );

        resolve(response.data as TranscriptionResponse);
      } catch (error) {
        reject(error);
      }
    });

    busboy.on("error", reject);

    if (req.rawBody) {
      busboy.end(req.rawBody);
    } else {
      req.pipe(busboy);
    }
  });

export const handleWhisper = async (
  req: Request,
  res: Response,
): Promise<void> => {
  if (req.method !== "POST") {
    res.set("Allow", "POST, OPTIONS");
    res.status(405).send("Method not allowed");
    return;
  }

  if (!verifyClientKey(req, res)) {
    return;
  }

  const apiKey = getOpenAiApiKey();

  if (!apiKey) {
    res
      .status(500)
      .json({error: "Server misconfiguration: OpenAI key missing"});
    return;
  }

  const result = await transcribeAudio(req as RequestWithRawBody, apiKey);

  res.status(200).json(result);
};

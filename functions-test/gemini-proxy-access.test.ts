import {PassThrough} from "node:stream";
import axios from "../functions/node_modules/axios/dist/node/axios.cjs";
import {handleGeminiChat} from "../functions/src/services/gemini/handler";
import {verifyFirebaseIdToken} from "../functions/src/middleware/auth";
import {checkAndConsumeQuota} from "../functions/src/middleware/quota";

jest.mock("../functions/node_modules/axios/dist/node/axios.cjs", () => ({
  __esModule: true,
  default: {post: jest.fn()},
  isAxiosError: jest.fn(),
}));
jest.mock("../functions/src/middleware/auth", () => ({
  verifyClientKey: jest.fn(() => true),
  verifyFirebaseIdToken: jest.fn(),
}));
jest.mock("../functions/src/middleware/appCheck", () => ({
  verifyAppCheck: jest.fn().mockResolvedValue(true),
}));
jest.mock("../functions/src/middleware/quota", () => ({
  checkAndConsumeQuota: jest.fn(),
}));

const mockResponse = () => ({
  writableEnded: false,
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
  setHeader: jest.fn(),
  write: jest.fn(),
  end: jest.fn(),
});

describe("Gemini owner-funded access", () => {
  const post = axios.post as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GEMINI_API_KEY = "test-server-gemini-key";
    (verifyFirebaseIdToken as jest.Mock).mockResolvedValue({
      uid: "test-general-user", isAnonymous: false,
    });
    (checkAndConsumeQuota as jest.Mock).mockResolvedValue(true);
  });

  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
  });

  it.each([
    ["gemini-3.8-flash", "gemini-3.8-flash"],
    ["gemini-3.1-pro-preview", "gemini-3.1-flash-lite"],
  ])("routes legacy %s requests to %s", async (model, expectedModel) => {
    post.mockResolvedValueOnce({
      data: {candidates: [{content: {parts: [{text: "OK"}]}}]},
    });
    const res = mockResponse();

    await handleGeminiChat({
      method: "POST",
      body: {model, messages: [{role: "user", content: "Reply OK"}]},
    } as never, res as never);

    expect(post.mock.calls[0][0]).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${expectedModel}:generateContent`,
    );
    expect(checkAndConsumeQuota).toHaveBeenCalledWith(
      "test-general-user", res, "chat", false,
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({message: "OK"}));
  });

  it.each([
    ["gemini-3.8-flash", "gemini-3.8-flash", false],
    ["gemini-3.8-flash", "gemini-3.8-flash", true],
    ["gemini-3.1-pro-preview", "gemini-3.1-flash-lite", false],
    ["gemini-3.1-pro-preview", "gemini-3.1-flash-lite", true],
  ])("routes native %s to %s (stream=%s)", async (model, expectedModel, stream) => {
    const upstream = new PassThrough();
    const response = {candidates: [{content: {parts: [{text: "OK"}]}}]};
    post.mockResolvedValueOnce({data: stream ? upstream : response});
    const res = mockResponse();
    const contents = [{
      role: "user",
      parts: [{functionResponse: {name: "lookup", response: {result: "OK"}}}],
    }];

    await handleGeminiChat({
      method: "POST",
      body: {model, contents, __proxyStreaming: stream},
    } as never, res as never);

    const endpoint = stream ? "streamGenerateContent" : "generateContent";
    expect(post.mock.calls[0][0]).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${expectedModel}:${endpoint}`,
    );
    expect(post.mock.calls[0][1]).toEqual({contents});
    expect(checkAndConsumeQuota).toHaveBeenCalledWith(
      "test-general-user", res, "chat", false,
    );
    if (stream) {
      upstream.emit("data", Buffer.from('data: {"modelVersion":"gemini-3.8-flash"}\n\n'));
      upstream.emit("end");
      expect(res.write).toHaveBeenCalled();
      expect(res.end).toHaveBeenCalled();
    } else {
      expect(res.json).toHaveBeenCalledWith(response);
    }
  });

  it("still requires a Firebase session before calling Google", async () => {
    (verifyFirebaseIdToken as jest.Mock).mockResolvedValueOnce(null);
    await handleGeminiChat({method: "POST", body: {
      model: "gemini-3.8-flash", contents: [],
    }} as never, mockResponse() as never);
    expect(post).not.toHaveBeenCalled();
    expect(checkAndConsumeQuota).not.toHaveBeenCalled();
  });

  it("still stops requests when the existing quota is exhausted", async () => {
    (checkAndConsumeQuota as jest.Mock).mockResolvedValueOnce(false);
    await handleGeminiChat({method: "POST", body: {
      model: "gemini-3.8-flash", contents: [],
    }} as never, mockResponse() as never);
    expect(post).not.toHaveBeenCalled();
  });
});

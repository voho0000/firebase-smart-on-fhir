// Auth middleware tests. Pure unit — firebase-admin is mocked so no emulator
// or real token is needed.
const verifyIdToken = jest.fn();
jest.mock("firebase-admin/auth", () => ({
  getAuth: () => ({verifyIdToken}),
}));
jest.mock("firebase-admin/app", () => ({
  getApps: () => [{}],
  initializeApp: jest.fn(),
}));

import {verifyClientKey, verifyFirebaseIdToken} from "../functions/src/middleware/auth";

type Hdrs = Record<string, string>;
function mockReq(headers: Hdrs = {}) {
  const lower: Hdrs = {};
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k];
  return {header: (n: string) => lower[n.toLowerCase()]} as never;
}
function mockRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res;
}

describe("verifyClientKey", () => {
  const OLD = process.env.CLIENT_KEYS;
  afterEach(() => {
    if (OLD === undefined) delete process.env.CLIENT_KEYS;
    else process.env.CLIENT_KEYS = OLD;
  });

  it("admits everyone when CLIENT_KEYS is unset (documented: key is public)", () => {
    delete process.env.CLIENT_KEYS;
    expect(verifyClientKey(mockReq(), mockRes() as never)).toBe(true);
  });

  it("rejects (401) when a key is configured but none/ wrong is provided", () => {
    process.env.CLIENT_KEYS = "good1,good2";
    const res1 = mockRes();
    expect(verifyClientKey(mockReq(), res1 as never)).toBe(false);
    expect(res1.statusCode).toBe(401);
    const res2 = mockRes();
    expect(verifyClientKey(mockReq({"x-proxy-key": "bad"}), res2 as never)).toBe(false);
    expect(res2.statusCode).toBe(401);
  });

  it("admits when the provided key matches", () => {
    process.env.CLIENT_KEYS = "good1,good2";
    expect(verifyClientKey(mockReq({"x-proxy-key": "good2"}), mockRes() as never)).toBe(true);
  });
});

describe("verifyFirebaseIdToken", () => {
  beforeEach(() => verifyIdToken.mockReset());

  it("401 and null when Authorization header is absent", async () => {
    const res = mockRes();
    expect(await verifyFirebaseIdToken(mockReq(), res as never)).toBeNull();
    expect(res.statusCode).toBe(401);
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it("401 and null when Authorization header is malformed", async () => {
    const res = mockRes();
    expect(await verifyFirebaseIdToken(mockReq({authorization: "Token abc"}), res as never)).toBeNull();
    expect(res.statusCode).toBe(401);
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it("returns {uid, isAnonymous:false} for a normal signed-in token", async () => {
    verifyIdToken.mockResolvedValue({uid: "alice", firebase: {sign_in_provider: "google.com"}});
    const r = await verifyFirebaseIdToken(mockReq({authorization: "Bearer xyz"}), mockRes() as never);
    expect(r).toEqual({uid: "alice", isAnonymous: false});
  });

  it("flags isAnonymous:true for an anonymous token", async () => {
    verifyIdToken.mockResolvedValue({uid: "anon1", firebase: {sign_in_provider: "anonymous"}});
    const r = await verifyFirebaseIdToken(mockReq({authorization: "Bearer xyz"}), mockRes() as never);
    expect(r).toEqual({uid: "anon1", isAnonymous: true});
  });

  it("401 and null when the token is invalid/expired (verifyIdToken throws)", async () => {
    verifyIdToken.mockRejectedValue(new Error("expired"));
    const res = mockRes();
    expect(await verifyFirebaseIdToken(mockReq({authorization: "Bearer bad"}), res as never)).toBeNull();
    expect(res.statusCode).toBe(401);
  });
});

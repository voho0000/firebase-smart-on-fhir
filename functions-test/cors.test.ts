// CORS middleware tests. Pure unit (no emulator).
// Locks in the two production CORS incidents recorded in the audit memory:
//   - iOS-only "Load failed": preflight must allow `User-Agent`.
//   - Claude "Failed to fetch": preflight must allow `anthropic-version`.
import {corsHandler} from "../functions/src/middleware/cors";

type Hdrs = Record<string, string>;

function mockReq(method: string, headers: Hdrs) {
  const lower: Hdrs = {};
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k];
  return {
    method,
    headers: lower,
    header: (n: string) => lower[n.toLowerCase()],
  } as never;
}

function mockRes() {
  const headers: Hdrs = {};
  const res = {
    statusCode: 200,
    setHeader: (k: string, v: string) => {
      headers[k.toLowerCase()] = String(v);
    },
    getHeader: (k: string) => headers[k.toLowerCase()],
    end: jest.fn(),
    _headers: headers,
  };
  return res as never as {
    statusCode: number;
    end: jest.Mock;
    _headers: Hdrs;
  };
}

describe("corsHandler", () => {
  const OLD = process.env.ALLOWED_ORIGINS;
  afterEach(() => {
    if (OLD === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = OLD;
  });

  it("allows any origin when ALLOWED_ORIGINS is unset (reflects origin)", (done) => {
    delete process.env.ALLOWED_ORIGINS;
    const req = mockReq("POST", {origin: "https://anything.example"});
    const res = mockRes();
    corsHandler(req, res as never, (err?: unknown) => {
      expect(err).toBeFalsy();
      expect(res._headers["access-control-allow-origin"])
        .toBe("https://anything.example");
      done();
    });
  });

  it("allows an allow-listed origin", (done) => {
    process.env.ALLOWED_ORIGINS = "https://voho0000.github.io,https://mediprisma.tw";
    const req = mockReq("POST", {origin: "https://mediprisma.tw"});
    const res = mockRes();
    corsHandler(req, res as never, (err?: unknown) => {
      expect(err).toBeFalsy();
      done();
    });
  });

  it("blocks a non-allow-listed origin when ALLOWED_ORIGINS is set", (done) => {
    process.env.ALLOWED_ORIGINS = "https://voho0000.github.io";
    const req = mockReq("POST", {origin: "https://evil.example"});
    const res = mockRes();
    corsHandler(req, res as never, (err?: unknown) => {
      expect(err).toBeTruthy();
      done();
    });
  });

  it("preflight allows User-Agent + anthropic-version (iOS & Claude regressions)", () => {
    delete process.env.ALLOWED_ORIGINS;
    const req = mockReq("OPTIONS", {
      origin: "https://voho0000.github.io",
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,user-agent,anthropic-version",
    });
    const res = mockRes();
    corsHandler(req, res as never, jest.fn());
    const allow = (res._headers["access-control-allow-headers"] || "").toLowerCase();
    expect(allow).toContain("user-agent");
    expect(allow).toContain("anthropic-version");
    expect(allow).toContain("authorization");
    // preflight is short-circuited by the cors middleware
    expect(res.end).toHaveBeenCalled();
  });
});

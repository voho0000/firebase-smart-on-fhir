// Quota middleware tests — run against the real Firestore emulator (via
// `firebase emulators:exec`) with the real Admin SDK, so this exercises the
// actual transactional metering that is the server-side source of truth (F1).
//
// Limits are pinned small via env in the npm script so 429 is reached quickly:
//   QUOTA_DAILY_LIMIT=3  QUOTA_ANON_LIMIT=2
//   QUOTA_DAILY_LIMIT_PERPLEXITY=2  QUOTA_DAILY_LIMIT_WHISPER=2
import {checkAndConsumeQuota} from "../functions/src/middleware/quota";

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

// Unique uid per test so the shared emulator state doesn't bleed across cases.
let n = 0;
const uid = (label: string) => `u-${label}-${n++}`;

describe("checkAndConsumeQuota (Firestore emulator)", () => {
  it("allows up to the chat limit (3) then returns 429", async () => {
    const u = uid("chat");
    const res = mockRes();
    expect(await checkAndConsumeQuota(u, res as never, "chat", false)).toBe(true);
    expect(await checkAndConsumeQuota(u, res as never, "chat", false)).toBe(true);
    expect(await checkAndConsumeQuota(u, res as never, "chat", false)).toBe(true);
    const blocked = await checkAndConsumeQuota(u, res as never, "chat", false);
    expect(blocked).toBe(false);
    expect(res.statusCode).toBe(429);
  });

  it("applies the smaller anonymous chat limit (2)", async () => {
    const u = uid("anon");
    const res = mockRes();
    expect(await checkAndConsumeQuota(u, res as never, "chat", true)).toBe(true);
    expect(await checkAndConsumeQuota(u, res as never, "chat", true)).toBe(true);
    expect(await checkAndConsumeQuota(u, res as never, "chat", true)).toBe(false);
  });

  it("meters perplexity and whisper in buckets separate from chat", async () => {
    const u = uid("sep");
    const res = mockRes();
    await checkAndConsumeQuota(u, res as never, "chat", false);
    await checkAndConsumeQuota(u, res as never, "chat", false);
    await checkAndConsumeQuota(u, res as never, "chat", false);
    expect(await checkAndConsumeQuota(u, res as never, "chat", false)).toBe(false);
    // Different fields — still available despite chat being exhausted.
    expect(await checkAndConsumeQuota(u, res as never, "perplexity", false)).toBe(true);
    expect(await checkAndConsumeQuota(u, res as never, "whisper", false)).toBe(true);
  });

  it("meters each uid independently", async () => {
    const a = uid("indep");
    const b = uid("indep");
    const res = mockRes();
    await checkAndConsumeQuota(a, res as never, "chat", false);
    await checkAndConsumeQuota(a, res as never, "chat", false);
    await checkAndConsumeQuota(a, res as never, "chat", false);
    expect(await checkAndConsumeQuota(a, res as never, "chat", false)).toBe(false);
    // Fresh uid is unaffected.
    expect(await checkAndConsumeQuota(b, res as never, "chat", false)).toBe(true);
  });
});

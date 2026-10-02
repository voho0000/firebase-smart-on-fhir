// submitLabDataReport — scan vectors, strict schema, and the handler against
// the real Firestore emulator (via `firebase emulators:exec`). Auth and App
// Check are mocked; everything Firestore-side is the real Admin SDK.
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {getApps, initializeApp} from "firebase-admin/app";
import {getFirestore} from "firebase-admin/firestore";
import {
  findDescriptionIdentifiers,
  findRowIdentifier,
  isShortResultText,
} from "../functions/src/services/lab-data-report/identifier-scan";
import {
  LabDataReportError,
  normalizeLabDataReport,
} from "../functions/src/services/lab-data-report/schema";
import {
  chunkRows,
  firestoreSize,
  handleLabDataReport,
  isConnectionTest,
  MAX_CHUNK_BYTES,
  RATE_LIMIT_COLLECTION,
  REPORTS_COLLECTION,
  ROWS_SUBCOLLECTION,
} from "../functions/src/services/lab-data-report/handler";
import {verifyFirebaseIdToken} from "../functions/src/middleware/auth";
import {
  composeLabReportNotice,
  sendLabReportNotice,
} from "../functions/src/services/lab-data-report/notify";
import {
  DESCRIPTION_VECTORS,
  RESULT_TEXT_VECTORS,
  ROW_VECTORS,
} from "./lab-data-report-vectors";

jest.mock("../functions/src/middleware/auth", () => ({
  verifyClientKey: jest.fn(() => true),
  verifyFirebaseIdToken: jest.fn(),
}));
jest.mock("../functions/src/middleware/appCheck", () => ({
  verifyAppCheck: jest.fn().mockResolvedValue(true),
}));
jest.mock("../functions/src/services/lab-data-report/notify", () => ({
  ...jest.requireActual("../functions/src/services/lab-data-report/notify"),
  sendLabReportNotice: jest.fn().mockResolvedValue(true),
}));

// The first Firestore transaction can include emulator cold-start time.
jest.setTimeout(30000);

// A payload produced by the app's own builder (synthetic observations).
const FIXTURE = JSON.parse(readFileSync(
  join(__dirname, "fixtures", "lab-data-report.v1.json"), "utf8",
));
const payload = () => JSON.parse(JSON.stringify(FIXTURE));

// MediCloud raw rows as the app's assembleRawLabSource emits them (synthetic).
const RAW_SOURCE = {
  producer: "medcloud2",
  producerVersion: "0.12.19",
  rows: [
    {
      ref: 1, source: "s02", ordinal: 1,
      dates: {
        case_time: {day: 0, time: "09:30:00"},
        real_inspect_date: {day: 0},
        recipe_date: {day: -1},
      },
      fields: {
        order_code: "08003C", order_name: "血色素檢查", assay_item_name: "Hb",
        unit_data: "g/dL", consult_value: "12~16", hosp: "合成醫院甲",
      },
      results: {assay_value: "11.2"},
      withheld: {inspect_result: 57},
    },
    {
      ref: 2, source: "s03", ordinal: 3,
      dates: {assaY_DATE: {day: -467}},
      fields: {assaY_NAME: "HbA1c"},
      results: {assaY_VALUE: 6.8},
      withheld: {},
    },
  ],
  s02Rows: 1,
  s03Rows: 1,
  endpointStatus: {s02: 200, s03: 200},
  truncatedRows: 0,
  droppedStrings: 0,
  unparsedDates: 0,
  unknownFields: ["new_col"],
};
const withRaw = () => ({...payload(), rawSource: JSON.parse(JSON.stringify(RAW_SOURCE))});

const reject = (body: unknown): string => {
  try {
    normalizeLabDataReport(body);
  } catch (error) {
    if (error instanceof LabDataReportError) return error.reason;
    throw error;
  }
  throw new Error("expected rejection");
};

describe("identifier scan (shared vectors)", () => {
  it.each(ROW_VECTORS)("row text %j → %s", (text, expected) => {
    expect(findRowIdentifier(text)).toBe(expected);
  });
  it.each(DESCRIPTION_VECTORS)("description %j → %j", (text, expected) => {
    expect([...findDescriptionIdentifiers(text)].sort())
      .toEqual([...expected].sort());
  });
  it.each(RESULT_TEXT_VECTORS)("result text %j short: %s", (text, expected) => {
    expect(isShortResultText(text)).toBe(expected);
  });
});

describe("chunkRows", () => {
  it("cuts by Firestore size, so large rows never overflow a 1 MiB document", () => {
    const big = {code: {text: "x".repeat(200)}, codings: Array.from({length: 10},
      () => ({system: "s".repeat(200), code: "c".repeat(200), display: "d".repeat(200)}))};
    const rows = Array.from({length: 300}, (_, ref) => ({...big, ref}));
    expect(firestoreSize(rows[0])).toBeGreaterThan(6000);
    const chunks = chunkRows(rows);
    expect(chunks.flat()).toHaveLength(300);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(firestoreSize(chunk)).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
    }
  });

  it("still caps a chunk at 250 small rows", () => {
    const chunks = chunkRows(Array.from({length: 600}, (_, ref) => ({ref})));
    expect(chunks.map((chunk) => chunk.length)).toEqual([250, 250, 100]);
  });

  it("measures strings in UTF-8 bytes, like Firestore", () => {
    expect(firestoreSize("尿液")).toBe(7);
    expect(firestoreSize({a: 1, b: [true, null]})).toBe(2 + 8 + 2 + 2);
  });
});

describe("normalizeLabDataReport", () => {
  it("accepts the app-built payload unchanged", () => {
    const {report, rowCount, serverDroppedStrings} =
      normalizeLabDataReport(payload());
    expect(rowCount).toBe(FIXTURE.rows.length);
    expect(serverDroppedStrings).toBe(0);
    expect(report).toEqual(FIXTURE);
  });

  it("rejects fields outside the contract, at any depth", () => {
    expect(reject({...payload(), patientId: "x"}))
      .toBe("body: unexpected field");
    const nested = payload();
    nested.rows[0].id = "Observation/1";
    expect(reject(nested)).toBe("rows[0]: unexpected field");
    const note = payload();
    note.rows[0].code.note = "free text";
    expect(reject(note)).toBe("rows[0].code: unexpected field");
    const dated = payload();
    dated.rows[0].sourceTags = ["nhi-visit-date:2026-01-01"];
    // An absolute date is dropped by the scan before the whitelist sees it.
    const datedOut = normalizeLabDataReport(dated);
    expect((datedOut.report.rows as Array<{sourceTags: string[]}>)[0]
      .sourceTags).toEqual([]);
    expect(datedOut.serverDroppedStrings).toBe(1);
    const unknownTag = payload();
    unknownTag.rows[0].sourceTags = ["patient-id:abc"];
    expect(reject(unknownTag))
      .toBe("rows[0].sourceTags[0]: tag not in whitelist");
  });

  it("accepts a report whose reporter picked no problem type", () => {
    const {report} = normalizeLabDataReport({
      ...payload(), problemType: "unspecified", description: "",
    });
    expect(report.problemType).toBe("unspecified");
    expect(report.description).toBe("");
  });

  it("rejects an unsupported schema, bad enums and oversized arrays", () => {
    expect(reject({...payload(), schemaVersion: 2}))
      .toBe("schemaVersion: unsupported");
    expect(reject({...payload(), problemType: "anything"}))
      .toBe("problemType: unexpected value");
    const many = payload();
    many.rows = Array.from({length: 3001}, () => many.rows[0]);
    expect(reject(many)).toBe("rows: more than 3000 items");
    expect(reject({...payload(), scope: {flaggedCategories: [7], categories: []}}))
      .toBe("scope.flaggedCategories[0]: expected a panel id");
    expect(reject({...payload(), rows: []})).toBe("rows: empty");
  });

  it("never echoes a submitted field name (it could carry an identifier)", () => {
    const body: Record<string, unknown> = payload();
    body["A123456789"] = true;
    const reason = reject(body);
    expect(reason).toBe("body: unexpected field");
    expect(reason).not.toContain("A123456789");
    const row = payload();
    row.rows[0]["病人王小明"] = 1;
    expect(reject(row)).toBe("rows[0]: unexpected field");
  });

  it("keeps panel ids to the app vocabulary; anything else becomes unknown", () => {
    const body = payload();
    body.scope.flaggedCategories = ["urine", "a123456789", "wang-xiao-ming", "urine"];
    body.scope.categories = [{categoryId: "f203xxx511", rows: 5}];
    body.rows[0].app.categoryId = "a123456789";
    const {report, serverUnknownPanels} = normalizeLabDataReport(body);
    expect(report.scope).toEqual({
      flaggedCategories: ["urine", "unknown"],
      categories: [{categoryId: "unknown", rows: 5}],
    });
    const rows = report.rows as Array<{app: {categoryId: string}}>;
    expect(rows[0].app.categoryId).toBe("unknown");
    expect(serverUnknownPanels).toBe(4);
    const all = JSON.stringify(report);
    for (const smuggled of ["a123456789", "wang-xiao-ming", "f203xxx511"]) {
      expect(all).not.toContain(smuggled);
    }
    const mail = composeLabReportNotice({
      reportId: "LDR-1", problemType: "other",
      flaggedCategories: ["a123456789"], categories: [{categoryId: "x", rows: 1}],
      rowCount: 1, includesValues: true, dataSource: "nhi", site: "unknown",
      hasDescription: false,
    }, "https://example.test");
    expect(`${mail.text}${mail.html}`).not.toContain("a123456789");
  });

  it("refuses a description that carries an identifier, with the kinds", () => {
    expect(reject({...payload(), description: "病歷號 12345678"}))
      .toBe("description-identifier:long-number");
  });

  it("drops row strings that look like identifiers or narrative", () => {
    const body = payload();
    body.rows[0].performer = ["病人 F203XXX511", "測試醫院"];
    body.rows[0].referenceRange = [{text: "採檢 2026/03/01"}];
    body.rows[0].value = {kind: "string", value: "大量白血球與細菌建議臨床追蹤並重新採檢", length: 19};
    const {report, serverDroppedStrings} = normalizeLabDataReport(body);
    const row = (report.rows as Array<Record<string, unknown>>)[0];
    expect(row.performer).toEqual(["測試醫院"]);
    expect(row.referenceRange).toEqual([]);
    expect(row.value).toEqual({kind: "string", length: 19});
    expect(serverDroppedStrings).toBe(3);
  });

  it("drops chart numbers, bare mobiles and old ROC birth dates in rows", () => {
    const body = payload();
    const texts = ["病歷號 12345678", "0912345678", "生日 65/3/12", "出生日期 79年3月12日"];
    body.rows[0].referenceRange = texts.slice(0, 2).map((text) => ({text}));
    body.rows[1].referenceRange = texts.slice(2).map((text) => ({text}));
    body.rows[2].performer = ["測試醫院;0601160016"];
    const {report, serverDroppedStrings} = normalizeLabDataReport(body);
    const rows = report.rows as Array<Record<string, unknown>>;
    expect(rows[0].referenceRange).toEqual([]);
    expect(rows[1].referenceRange).toEqual([]);
    expect(rows[2].performer).toEqual([]);
    expect(serverDroppedStrings).toBe(5);
  });

  it.each([
    [["survey"]],
    [["vital-signs"]],
    [["laboratory", "survey"]],
    [["laboratory", "exam"]],
    [[]],
  ])("refuses a row whose category is %j", (category) => {
    const body = payload();
    body.rows[3].category = category;
    expect(reject(body)).toBe("rows[3].category: not laboratory");
  });

  it("accepts laboratory next to a local category code", () => {
    const body = payload();
    body.rows[0].category = ["laboratory", "chemistry"];
    const {report} = normalizeLabDataReport(body);
    const rows = report.rows as Array<{category: string[]}>;
    expect(rows[0].category).toEqual(["laboratory", "chemistry"]);
  });
});

const mockRes = () => {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    set(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    send(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return res;
};

// A fresh IP per run: the emulator keeps rate-limit buckets across runs, and
// a shared test IP would trip the 30/hour limit on the third run in an hour.
const RUN_IP = `198.18.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;

const mockReq = (body: unknown, overrides: Record<string, unknown> = {}) => {
  const json = JSON.stringify(body);
  return {
    method: "POST",
    body,
    rawBody: Buffer.from(json),
    is: (type: string) => type === "application/json",
    header: (name: string) =>
      name.toLowerCase() === "x-forwarded-for" ? RUN_IP : undefined,
    ...overrides,
  };
};

let n = 0;
const uid = (label: string) => `lab-report-${label}-${Date.now()}-${n++}`;

describe("normalizeLabDataReport — MediCloud raw rows", () => {
  it("accepts the app's raw block and returns its rows apart", () => {
    const {report, rawRows, serverDroppedStrings} = normalizeLabDataReport(withRaw());
    expect(rawRows).toEqual(RAW_SOURCE.rows);
    expect(report.rawSource).toEqual({
      producer: "medcloud2",
      producerVersion: "0.12.19",
      s02Rows: 1,
      s03Rows: 1,
      endpointStatus: {s02: 200, s03: 200},
      truncatedRows: 0,
      droppedStrings: 0,
      unparsedDates: 0,
      unknownFields: ["new_col"],
    });
    expect(serverDroppedStrings).toBe(0);
  });

  it("has no raw rows when none were attached", () => {
    expect(normalizeLabDataReport(payload()).rawRows).toEqual([]);
  });

  it.each([
    ["an S02 field outside the allowlist", (b: any) => {
      b.rawSource.rows[0].fields.hosp_id = "SYNTH";
    }, "rawSource.rows[0].fields: unexpected field"],
    ["an S02 field on an S03 row", (b: any) => {
      b.rawSource.rows[1].fields.order_code = "08003C";
    }, "rawSource.rows[1].fields: unexpected field"],
    ["a diagnosis", (b: any) => {
      b.rawSource.rows[0].fields.icd_code = "Z00.0";
    }, "rawSource.rows[0].fields: unexpected field"],
    ["an absolute date", (b: any) => {
      b.rawSource.rows[0].dates.case_time = "2026-03-02";
    }, "rawSource.rows[0].dates.case_time: expected object"],
    ["a date field outside the allowlist", (b: any) => {
      b.rawSource.rows[0].dates.log2time = {day: 1};
    }, "rawSource.rows[0].dates: unexpected field"],
    ["a malformed time", (b: any) => {
      b.rawSource.rows[0].dates.case_time.time = "09:30 +08:00";
    }, "rawSource.rows[0].dates.case_time.time: expected HH:MM[:SS]"],
    ["values when the reporter withheld them", (b: any) => {
      b.includesValues = false;
    }, "rawSource.rows[0].results: values not attached"],
    ["an unknown producer", (b: any) => {
      b.rawSource.producer = "other";
    }, "rawSource.producer: unexpected value"],
    ["an unexpected block field", (b: any) => {
      b.rawSource.patient = "F203XXX511";
    }, "rawSource: unexpected field"],
    ["a field name that is not a plain name", (b: any) => {
      b.rawSource.unknownFields = ["a b"];
    }, "rawSource.unknownFields[0]: unexpected value"],
    ["raw rows and an error together", (b: any) => {
      b.rawSourceError = "EXPIRED";
    }, "rawSourceError: raw rows are attached"],
  ])("refuses %s", (_label, mutate, reason) => {
    const body = withRaw();
    mutate(body);
    expect(reject(body)).toBe(reason);
  });

  it("drops identifier-like raw strings and narrative results, and counts them", () => {
    const body = withRaw();
    body.rawSource.rows[0].fields.consult_value = "病歷號 12345678";
    body.rawSource.rows[0].fields.hosp = "合成醫院 0912345678";
    body.rawSource.rows[0].results.assay_value = "生日 65/3/12";
    body.rawSource.rows[1].fields.assaY_NAME = "大量白血球與細菌建議臨床追蹤並重新採檢以排除污染";
    const {rawRows, serverDroppedStrings} = normalizeLabDataReport(body);
    expect(rawRows[0].fields).toEqual({
      order_code: "08003C", order_name: "血色素檢查", assay_item_name: "Hb", unit_data: "g/dL",
    });
    expect(rawRows[0].results).toEqual({});
    expect(serverDroppedStrings).toBe(3);
    expect(rawRows[1].fields).toEqual({assaY_NAME: "大量白血球與細菌建議臨床追蹤並重新採檢以排除污染"});
  });

  it.each(["A123456789", "0.12.19 A123456789", "0.12.19-beta", "v0.12.19", "1.2.3.4.5"])(
    "refuses producer version %j that is not a version number", (version) => {
      const body = withRaw();
      body.rawSource.producerVersion = version;
      expect(reject(body)).toBe("rawSource.producerVersion: unexpected value");
    });

  it("drops a well-formed producer version that reads as a date", () => {
    const body = withRaw();
    body.rawSource.producerVersion = "2026.07.04";
    const {report, serverDroppedStrings} = normalizeLabDataReport(body);
    expect((report.rawSource as {producerVersion?: string}).producerVersion)
      .toBeUndefined();
    expect(serverDroppedStrings).toBe(1);
  });

  it("records why raw rows are missing", () => {
    const body = {...payload(), rawSourceError: "PATIENT_UNVERIFIED"};
    expect(normalizeLabDataReport(body).report.rawSourceError).toBe("PATIENT_UNVERIFIED");
    expect(reject({...payload(), rawSourceError: "SOMETHING"})).toBe("rawSourceError: unexpected value");
  });
});

describe("handleLabDataReport (Firestore emulator)", () => {
  beforeAll(() => {
    if (getApps().length === 0) initializeApp({projectId: "demo-mediprisma"});
  });

  const signIn = (id: string, isAnonymous = true) =>
    (verifyFirebaseIdToken as jest.Mock)
      .mockResolvedValue({uid: id, isAnonymous});

  it("stores the report with reporter, 90-day expiry and schema version", async () => {
    const reporter = uid("store");
    signIn(reporter);
    const res = mockRes();
    const before = Date.now();
    await handleLabDataReport(mockReq(payload()) as never, res as never);
    expect(res.statusCode).toBe(200);
    const {reportId} = res.body as {reportId: string};
    expect(reportId).toMatch(/^LDR-\d{8}-[0-9A-F]{8}$/);

    const reportRef = getFirestore("mediprisma")
      .collection(REPORTS_COLLECTION).doc(reportId);
    const data = (await reportRef.get()).data()!;
    expect(data.reporterUid).toBe(reporter);
    expect(data.reporterIsAnonymous).toBe(true);
    expect(data.schemaVersion).toBe(1);
    expect(data.rowCount).toBe(FIXTURE.rows.length);
    expect(data.rows).toBeUndefined();
    expect(data.scope).toEqual(FIXTURE.scope);
    const chunks = await reportRef.collection(ROWS_SUBCOLLECTION)
      .orderBy("chunk").get();
    expect(chunks.docs.flatMap((chunk) => chunk.get("rows")))
      .toEqual(FIXTURE.rows);
    expect(data.createdAt).toBeDefined();
    const days = (data.expireAt.toMillis() - before) / 86_400_000;
    expect(days).toBeGreaterThan(89.99);
    expect(days).toBeLessThan(90.01);
  });

  it("splits a whole-patient report into 250-row chunks, atomically", async () => {
    signIn(uid("chunks"));
    const body = payload();
    body.rows = Array.from({length: 1300}, (_, i) => ({
      ...FIXTURE.rows[i % FIXTURE.rows.length], ref: i + 1,
    }));
    delete body.rows[0].sameValueGroup;
    const res = mockRes();
    await handleLabDataReport(mockReq(body) as never, res as never);
    expect(res.statusCode).toBe(200);
    const reportRef = getFirestore("mediprisma")
      .collection(REPORTS_COLLECTION).doc((res.body as {reportId: string}).reportId);
    const data = (await reportRef.get()).data()!;
    expect(data.rowChunks).toBe(6);
    const chunks = await reportRef.collection(ROWS_SUBCOLLECTION)
      .orderBy("chunk").get();
    expect(chunks.size).toBe(6);
    const rows = chunks.docs.flatMap((chunk) => chunk.get("rows"));
    expect(rows.map((row: {ref: number}) => row.ref))
      .toEqual(Array.from({length: 1300}, (_, i) => i + 1));
    // Every chunk carries the same TTL ceiling as the report.
    for (const chunk of chunks.docs) {
      expect(chunk.get("expireAt").toMillis()).toBe(data.expireAt.toMillis());
    }
  });

  it("stores MediCloud raw rows as their own chunks under the report", async () => {
    signIn(uid("raw"));
    const body = withRaw();
    body.rawSource.rows = Array.from({length: 600}, (_, i) => ({
      ...RAW_SOURCE.rows[i % 2], ref: i + 1,
    }));
    const res = mockRes();
    await handleLabDataReport(mockReq(body) as never, res as never);
    expect(res.statusCode).toBe(200);
    const reportRef = getFirestore("mediprisma")
      .collection(REPORTS_COLLECTION).doc((res.body as {reportId: string}).reportId);
    const data = (await reportRef.get()).data()!;
    expect(data.rawRowCount).toBe(600);
    expect(data.rawRowChunks).toBe(3);
    expect(data.rawSource.producerVersion).toBe("0.12.19");
    expect(data.rawSource.rows).toBeUndefined();
    const all = await reportRef.collection(ROWS_SUBCOLLECTION).get();
    const raw = all.docs.filter((doc) => doc.get("kind") === "raw")
      .sort((a, b) => a.get("chunk") - b.get("chunk"));
    expect(raw.map((doc) => doc.id)).toEqual(["raw-000", "raw-001", "raw-002"]);
    expect(raw.flatMap((doc) => doc.get("rows")).map((row: {ref: number}) => row.ref))
      .toEqual(Array.from({length: 600}, (_, i) => i + 1));
    const converted = all.docs.filter((doc) => doc.get("kind") === undefined);
    expect(converted.flatMap((doc) => doc.get("rows"))).toHaveLength(data.rowCount);
    for (const doc of all.docs) {
      expect(doc.get("expireAt").toMillis()).toBe(data.expireAt.toMillis());
    }
  });

  it("mails a metadata-only notice once per stored report", async () => {
    (sendLabReportNotice as jest.Mock).mockClear();
    signIn(uid("notice"));
    const body = {...payload(), submissionKey: "c".repeat(64)};
    const first = mockRes();
    await handleLabDataReport(mockReq(body) as never, first as never);
    // A resend returns the stored report and does not mail again.
    await handleLabDataReport(mockReq(body) as never, mockRes() as never);
    expect(sendLabReportNotice).toHaveBeenCalledTimes(1);
    const notice = (sendLabReportNotice as jest.Mock).mock.calls[0][0];
    expect(notice).toEqual({
      reportId: (first.body as {reportId: string}).reportId,
      problemType: FIXTURE.problemType,
      flaggedCategories: FIXTURE.scope.flaggedCategories,
      categories: FIXTURE.scope.categories,
      rowCount: FIXTURE.rows.length,
      rawRowCount: 0,
      includesValues: FIXTURE.includesValues,
      dataSource: FIXTURE.context.dataSource,
      site: FIXTURE.context.site,
      hasDescription: true,
    });

    const mail = composeLabReportNotice(notice, "https://example.test/lab-reports");
    const all = `${mail.subject}\n${mail.text}\n${mail.html}`;
    expect(mail.subject).toBe("[檢驗資料回報] 生化 · 重複值 · 5 列");
    expect(all).toContain(`https://example.test/lab-reports?id=${notice.reportId}`);
    expect(mail.text).toContain("雲端病歷原始列：未附");
    expect(composeLabReportNotice({...notice, rawRowCount: 600}).text)
      .toContain("雲端病歷原始列：600 列");
    // No note text, hospital, test name, code or value ever reaches the inbox.
    for (const secret of [
      FIXTURE.description, "4.41", "測試醫院", "0936050029", "Hemoglobin",
      "718-7", "08003C", "K",
    ]) {
      expect(mail.text).not.toContain(secret);
      expect(mail.html).not.toContain(secret);
    }
  });

  it("returns the first report for a resend of the same payload", async () => {
    signIn(uid("resend"));
    const body = {...payload(), submissionKey: "a".repeat(64)};
    const first = mockRes();
    await handleLabDataReport(mockReq(body) as never, first as never);
    const second = mockRes();
    await handleLabDataReport(mockReq(body) as never, second as never);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const firstId = (first.body as {reportId: string}).reportId;
    expect((second.body as {reportId: string}).reportId).toBe(firstId);
    const stored = await getFirestore("mediprisma")
      .collection(REPORTS_COLLECTION).doc(firstId).get();
    expect(stored.get("submissionKey")).toBeUndefined();

    // Another reporter with the same content is a separate report.
    signIn(uid("resend-other"));
    const other = mockRes();
    await handleLabDataReport(mockReq(body) as never, other as never);
    expect((other.body as {reportId: string}).reportId).not.toBe(firstId);
    expect(reject({...payload(), submissionKey: "not-a-digest"}))
      .toBe("submissionKey: expected a SHA-256 hex digest");
  });

  it("stores near-maximum rows without hitting the document size limit", async () => {
    signIn(uid("big-rows"));
    const heavy = (ref: number) => ({
      ...FIXTURE.rows[0],
      ref,
      code: {
        text: "t".repeat(200),
        codings: Array.from({length: 10}, (_, i) => ({
          system: `https://example.test/${"s".repeat(170)}${i}`,
          code: `C${i}`.padEnd(200, "0"),
          display: "顯".repeat(66),
        })),
      },
      performer: ["院".repeat(40), "所".repeat(40), "名".repeat(40)],
      sourceTags: Array.from({length: 16}, (_, i) => `source-module:${"m".repeat(100)}${i}`),
    });
    const body = payload();
    body.rows = Array.from({length: 300}, (_, i) => heavy(i + 1));
    delete body.rows[0].sameValueGroup;
    const res = mockRes();
    await handleLabDataReport(mockReq(body) as never, res as never);
    expect(res.statusCode).toBe(200);
    const reportRef = getFirestore("mediprisma")
      .collection(REPORTS_COLLECTION).doc((res.body as {reportId: string}).reportId);
    const chunks = await reportRef.collection(ROWS_SUBCOLLECTION).orderBy("chunk").get();
    // 250 fixed-count rows of this size would be ~2.5 MB in one document.
    expect(chunks.size).toBeGreaterThan(2);
    for (const chunk of chunks.docs) {
      expect(firestoreSize(chunk.data())).toBeLessThan(1024 * 1024);
    }
    expect(chunks.docs.flatMap((chunk) => chunk.get("rows")).map((row: {ref: number}) => row.ref))
      .toEqual(Array.from({length: 300}, (_, i) => i + 1));
  });

  it("answers 400 with the reason and stores nothing for a bad report", async () => {
    signIn(uid("bad"));
    const res = mockRes();
    await handleLabDataReport(
      mockReq({...payload(), description: "0912345678"}) as never,
      res as never,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({
      success: false,
      reason: "description-identifier:phone,long-number",
    }));
  });

  it("answers a connection test without storing it or counting it", async () => {
    const tester = uid("connection");
    signIn(tester, false);
    (sendLabReportNotice as jest.Mock).mockClear();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = mockRes();
      await handleLabDataReport(
        mockReq(i % 2 ? JSON.stringify({connectionTest: true}) : {connectionTest: true}) as never,
        res as never,
      );
      statuses.push(res.statusCode);
      expect(res.body).toEqual({success: true, connectionTest: true});
    }
    expect(statuses.every((status) => status === 200)).toBe(true);
    const stored = await getFirestore("mediprisma")
      .collection(REPORTS_COLLECTION).where("reporterUid", "==", tester).get();
    expect(stored.empty).toBe(true);
    expect(sendLabReportNotice).not.toHaveBeenCalled();

    // Still a whole report's allowance after the tests.
    const report = mockRes();
    await handleLabDataReport(mockReq(payload()) as never, report as never);
    expect(report.statusCode).toBe(200);
    expect(report.body).toEqual(expect.objectContaining({success: true}));
  });

  it("holds anything beside the connection-test flag to the report contract", async () => {
    signIn(uid("connection-extra"));
    for (const body of [
      {connectionTest: true, description: ""},
      {connectionTest: false},
      {connectionTest: "true"},
      [{connectionTest: true}],
    ]) {
      const res = mockRes();
      await handleLabDataReport(mockReq(body) as never, res as never);
      expect(res.statusCode).toBe(400);
    }
    expect(isConnectionTest("{not json")).toBe(false);
    expect(isConnectionTest(null)).toBe(false);
  });

  it("refuses non-JSON, oversize and non-POST requests", async () => {
    signIn(uid("shape"));
    const notJson = mockRes();
    await handleLabDataReport(
      mockReq(payload(), {is: () => false}) as never, notJson as never,
    );
    expect(notJson.statusCode).toBe(415);

    const big = mockRes();
    await handleLabDataReport(
      mockReq(payload(), {rawBody: Buffer.alloc(4 * 1024 * 1024 + 1)}) as never,
      big as never,
    );
    expect(big.statusCode).toBe(413);

    const get = mockRes();
    await handleLabDataReport(
      mockReq(payload(), {method: "GET"}) as never, get as never,
    );
    expect(get.statusCode).toBe(405);
  });

  it("stops after 10 reports an hour from one uid", async () => {
    signIn(uid("limit"), false);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = mockRes();
      await handleLabDataReport(
        mockReq(payload(), {
          header: (name: string) =>
            name.toLowerCase() === "x-forwarded-for" ? `198.51.100.${i}` :
              undefined,
        }) as never,
        res as never,
      );
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 10).every((status) => status === 200)).toBe(true);
    expect(statuses[10]).toBe(429);

    // Buckets are keyed by digest: no uid or IP in the rate-limit collection.
    const buckets = await getFirestore("mediprisma")
      .collection(RATE_LIMIT_COLLECTION).get();
    for (const bucket of buckets.docs) {
      expect(bucket.id).toMatch(/^[0-9a-f]{40}$/);
      expect(Object.keys(bucket.data()).sort())
        .toEqual(expect.arrayContaining(["count", "windowStart"]));
    }
  });
});

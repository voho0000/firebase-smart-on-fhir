// Strict validation of a lab-data problem report (schemaVersion 1). Mirrors
// the app's wire contract in medical-note-smart-on-fhir
// features/lab-data-report/types.ts — change both together.
//
// Anything outside the contract is rejected rather than stored: an unknown
// field is the easiest way for a future client to leak something the
// disclosure never mentioned. Row strings are re-scanned for identifiers with
// the same rules the app uses; a match drops that string and is counted.
import {
  findDescriptionIdentifiers,
  findRowIdentifier,
  isShortResultText,
  type IdentifierKind,
} from "./identifier-scan";

export const LAB_DATA_REPORT_SCHEMA_VERSION = 1;
// Every laboratory row of the patient's cumulative report; real patients
// carry up to ~1,400 (2026-09-27).
export const MAX_ROWS = 3000;
export const MAX_DESCRIPTION = 1000;
const MAX_VALUE_STRING = 40;
const MAX_RANGE_TEXT = 120;
const MAX_STRING = 200;

const PROBLEM_TYPES = [
  "wrong-panel",
  "split-column",
  "duplicate",
  "value-unit",
  "name",
  "other",
  // The reporter did not pick one; the rows carry the evidence.
  "unspecified",
] as const;
const DATA_SOURCES = [
  "medcloud", "nhi", "smart", "demo", "import", "unknown",
] as const;
const SITES = ["vghtpe", "unknown"] as const;
// Every observation-category code but laboratory (app:
// features/lab-data-report/utils/laboratory-scope.ts).
const NON_LAB_CATEGORY_CODES = new Set([
  "social-history", "vital-signs", "imaging", "survey", "exam", "therapy",
  "activity", "procedure",
]);
const NAME_MODES = ["standardized", "original"] as const;
const SOURCE_TAG_NAMES = new Set([
  "source-program",
  "nhi-source-channel",
  "dedup-provenance",
  "nhi-source-occurrence-count",
  "sdk-unit-origin",
  "source-module",
  "adapter-version",
  "data-class",
  "data-quality",
  "source-reconciliation",
]);
const DECISIONS = [
  "microbiology",
  "specimen-urine",
  "specimen-non-blood",
  "loinc",
  "code",
  "display",
  "canonical",
  "text-urine",
  "qualitative",
  "fallback",
  "none",
] as const;

/** A report the Function refuses, with a reason safe to show the client. */
export class LabDataReportError extends Error {
  /**
   * @param {string} reason - Machine-readable reason.
   */
  constructor(readonly reason: string) {
    super(reason);
    this.name = "LabDataReportError";
  }
}

const fail = (reason: string): never => {
  throw new LabDataReportError(reason);
};

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const expectObject = (value: unknown, where: string): Json =>
  isObject(value) ? value : fail(`${where}: expected object`);

// The reason names the schema path only, never the offending key: a key is
// attacker-chosen text (it could carry an ID number), and the reason is both
// logged and returned to the client.
const onlyKeys = (value: Json, allowed: readonly string[], where: string) => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${where}: unexpected field`);
  }
};

const expectArray = (
  value: unknown,
  where: string,
  max: number,
): unknown[] => {
  if (!Array.isArray(value)) return fail(`${where}: expected array`);
  if (value.length > max) return fail(`${where}: more than ${max} items`);
  return value;
};

const expectEnum = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  where: string,
): T =>
    typeof value === "string" &&
    (allowed as readonly string[]).includes(value) ?
      value as T :
      fail(`${where}: unexpected value`);

const expectInteger = (
  value: unknown,
  where: string,
  min: number,
  max: number,
): number =>
  typeof value === "number" && Number.isInteger(value) &&
  value >= min && value <= max ?
    value :
    fail(`${where}: expected integer ${min}..${max}`);

const optionalFinite = (value: unknown, where: string): number | undefined => {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isFinite(value) ?
    value :
    fail(`${where}: expected number`);
};

/** Collects the scan results while one report is normalised. */
interface ScanBudget {
  dropped: number;
  unknownPanels: number;
}

/**
 * A source string: type- and length-checked, then scanned. Returns undefined
 * (and counts it) when the scan matches.
 * @param {unknown} value - Submitted value.
 * @param {string} where - Field path for the rejection reason.
 * @param {ScanBudget} budget - Drop counter for this report.
 * @param {number} max - Longest accepted string.
 * @return {string | undefined} The string, or undefined when absent/dropped.
 */
const rowString = (
  value: unknown,
  where: string,
  budget: ScanBudget,
  max = MAX_STRING,
): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return fail(`${where}: expected string`);
  if (value.length > max) return fail(`${where}: longer than ${max}`);
  if (findRowIdentifier(value)) {
    budget.dropped += 1;
    return undefined;
  }
  return value;
};

/**
 * A source result string: like rowString, and additionally dropped when it
 * reads as narrative rather than a short result.
 * @param {unknown} value - Submitted value.
 * @param {string} where - Field path for the rejection reason.
 * @param {ScanBudget} budget - Drop counter for this report.
 * @return {string | undefined} The string, or undefined when absent/dropped.
 */
const resultString = (
  value: unknown,
  where: string,
  budget: ScanBudget,
): string | undefined => {
  const text = rowString(value, where, budget, MAX_VALUE_STRING);
  if (text === undefined || isShortResultText(text)) return text;
  budget.dropped += 1;
  return undefined;
};

// The app's cumulative-report panels — LAB_CATEGORIES ids in
// medical-note-smart-on-fhir src/shared/utils/lab-categories.ts. A panel id
// reaches the notice mail, so only these travel; anything else is stored as
// "unknown" and counted (a panel the app adds later still reports, but no
// free text can ride along in this field).
export const PANEL_IDS = [
  "cbc", "coag", "chem", "endocrine", "lipid", "glucose", "hep", "tumor",
  "urine", "bloodgas", "serology", "microbio", "other",
] as const;
export const UNKNOWN_PANEL = "unknown";

/**
 * A lab panel id from the fixed app vocabulary, else "unknown" (counted).
 * @param {unknown} value - Submitted value.
 * @param {string} where - Field path for the rejection reason.
 * @param {ScanBudget} budget - Counters for this report.
 * @return {string} The panel id, or "unknown".
 */
const panelIdOf = (
  value: unknown,
  where: string,
  budget: ScanBudget,
): string => {
  if (typeof value !== "string") return fail(`${where}: expected a panel id`);
  if ((PANEL_IDS as readonly string[]).includes(value)) return value;
  budget.unknownPanels += 1;
  return UNKNOWN_PANEL;
};

const assign = <T extends Json>(target: T, key: string, value: unknown) => {
  if (value !== undefined) (target as Json)[key] = value;
};

const normalizeValue = (raw: unknown, where: string, budget: ScanBudget) => {
  const value = expectObject(raw, where);
  const kind = expectEnum(
    value.kind,
    ["quantity", "range", "coded", "string", "other", "none"],
    `${where}.kind`,
  );
  const out: Json = {kind};
  switch (kind) {
  case "quantity":
    onlyKeys(
      value,
      ["kind", "value", "comparator", "magnitude", "decimals"],
      where,
    );
    assign(out, "value", optionalFinite(value.value, `${where}.value`));
    if (value.comparator !== undefined) {
      assign(out, "comparator", expectEnum(
        value.comparator, ["<", "<=", ">=", ">", "ad"], `${where}.comparator`,
      ));
    }
    out.magnitude = value.magnitude === null ?
      null :
      expectInteger(value.magnitude, `${where}.magnitude`, -30, 30);
    out.decimals = expectInteger(value.decimals, `${where}.decimals`, 0, 30);
    break;
  case "range":
    onlyKeys(value, ["kind", "low", "high"], where);
    assign(out, "low", optionalFinite(value.low, `${where}.low`));
    assign(out, "high", optionalFinite(value.high, `${where}.high`));
    break;
  case "coded":
    onlyKeys(value, ["kind", "code", "text"], where);
    assign(out, "code", rowString(
      value.code, `${where}.code`, budget, MAX_VALUE_STRING,
    ));
    assign(out, "text", resultString(value.text, `${where}.text`, budget));
    break;
  case "string":
    onlyKeys(value, ["kind", "value", "length"], where);
    assign(out, "value", resultString(value.value, `${where}.value`, budget));
    out.length = expectInteger(value.length, `${where}.length`, 0, 1_000_000);
    break;
  case "other":
    onlyKeys(value, ["kind", "type"], where);
    out.type = rowString(value.type, `${where}.type`, budget, 40) ?? "";
    break;
  case "none":
    onlyKeys(value, ["kind"], where);
    break;
  }
  return out;
};

const normalizeRow = (
  raw: unknown,
  index: number,
  budget: ScanBudget,
): Json => {
  const where = `rows[${index}]`;
  const row = expectObject(raw, where);
  onlyKeys(row, [
    "ref", "day", "timeOfDay", "sourceTime", "performer", "code", "category",
    "specimen", "status", "unit", "unitCode", "value", "sameValueGroup",
    "interpretation", "referenceRange", "sourceExtensions", "sourceTags",
    "app",
  ], where);

  const out: Json = {
    ref: expectInteger(row.ref, `${where}.ref`, 1, MAX_ROWS),
    day: row.day === null ?
      null :
      expectInteger(row.day, `${where}.day`, 0, 100_000),
  };
  if (row.timeOfDay !== undefined) {
    if (
      typeof row.timeOfDay !== "string" ||
      !/^\d{2}:\d{2}(?::\d{2})?$/.test(row.timeOfDay)
    ) {
      fail(`${where}.timeOfDay: expected HH:MM[:SS]`);
    }
    out.timeOfDay = row.timeOfDay;
  }
  if (row.sourceTime !== undefined) {
    const sourceTime = expectObject(row.sourceTime, `${where}.sourceTime`);
    onlyKeys(sourceTime, ["dayDelta", "time"], `${where}.sourceTime`);
    if (
      typeof sourceTime.time !== "string" ||
      !/^\d{2}:\d{2}(?::\d{2})?$/.test(sourceTime.time)
    ) {
      fail(`${where}.sourceTime.time: expected HH:MM[:SS]`);
    }
    out.sourceTime = {
      dayDelta: expectInteger(
        sourceTime.dayDelta, `${where}.sourceTime.dayDelta`, -3660, 3660,
      ),
      time: sourceTime.time,
    };
  }

  out.performer = expectArray(row.performer, `${where}.performer`, 3)
    .map((name, i) =>
      rowString(name, `${where}.performer[${i}]`, budget, 120))
    .filter((name): name is string => name !== undefined);

  const code = expectObject(row.code, `${where}.code`);
  onlyKeys(code, ["text", "codings"], `${where}.code`);
  const codeOut: Json = {};
  assign(codeOut, "text", rowString(code.text, `${where}.code.text`, budget));
  codeOut.codings = expectArray(code.codings, `${where}.code.codings`, 10)
    .map((rawCoding, i) => {
      const at = `${where}.code.codings[${i}]`;
      const coding = expectObject(rawCoding, at);
      onlyKeys(coding, ["system", "code", "display"], at);
      const codingOut: Json = {};
      assign(codingOut, "system",
        rowString(coding.system, `${at}.system`, budget));
      assign(codingOut, "code", rowString(coding.code, `${at}.code`, budget));
      assign(codingOut, "display",
        rowString(coding.display, `${at}.display`, budget));
      return codingOut;
    })
    .filter((coding) => Object.keys(coding).length > 0);
  out.code = codeOut;

  const category = expectArray(row.category, `${where}.category`, 8)
    .map((c, i) => rowString(c, `${where}.category[${i}]`, budget, 64))
    .filter((c): c is string => c !== undefined);
  // Policy boundary (PRIVACY_POLICY §2.10): laboratory rows only. The app
  // sends a row only when its FHIR category is laboratory and carries no
  // other observation-category code; anything else is refused, not stored.
  if (!category.includes("laboratory") ||
      category.some((code) => NON_LAB_CATEGORY_CODES.has(code))) {
    fail(`${where}.category: not laboratory`);
  }
  out.category = category;
  assign(out, "specimen",
    rowString(row.specimen, `${where}.specimen`, budget, 120));
  if (row.status !== undefined) {
    if (typeof row.status !== "string" || !/^[a-z-]{1,24}$/.test(row.status)) {
      fail(`${where}.status: unexpected value`);
    }
    out.status = row.status;
  }
  assign(out, "unit", rowString(row.unit, `${where}.unit`, budget, 64));
  assign(out, "unitCode",
    rowString(row.unitCode, `${where}.unitCode`, budget, 64));
  out.value = normalizeValue(row.value, `${where}.value`, budget);
  if (row.sameValueGroup !== undefined) {
    out.sameValueGroup = expectInteger(
      row.sameValueGroup, `${where}.sameValueGroup`, 1, MAX_ROWS,
    );
  }
  out.interpretation = expectArray(
    row.interpretation, `${where}.interpretation`, 5,
  ).map((code, i) => {
    if (typeof code !== "string" || !/^[A-Za-z<>=+-]{1,8}$/.test(code)) {
      fail(`${where}.interpretation[${i}]: unexpected value`);
    }
    return code;
  });
  out.referenceRange = expectArray(
    row.referenceRange, `${where}.referenceRange`, 3,
  ).map((rawRange, i) => {
    const at = `${where}.referenceRange[${i}]`;
    const range = expectObject(rawRange, at);
    onlyKeys(range, ["low", "high", "unit", "text"], at);
    const rangeOut: Json = {};
    assign(rangeOut, "low", optionalFinite(range.low, `${at}.low`));
    assign(rangeOut, "high", optionalFinite(range.high, `${at}.high`));
    assign(rangeOut, "unit", rowString(range.unit, `${at}.unit`, budget, 64));
    assign(rangeOut, "text",
      rowString(range.text, `${at}.text`, budget, MAX_RANGE_TEXT));
    return rangeOut;
  }).filter((range) => Object.keys(range).length > 0);
  out.sourceExtensions = expectArray(
    row.sourceExtensions, `${where}.sourceExtensions`, 12,
  ).map((rawExtension, i) => {
    const at = `${where}.sourceExtensions[${i}]`;
    const extension = expectObject(rawExtension, at);
    onlyKeys(extension, ["name", "value"], at);
    const name = expectEnum(extension.name, [
      "medcloud-source-assay-category",
      "medcloud-source-inspect-mode",
      "medcloud-source-data-mark",
      "medcloud-source-system",
      "medcloud-historical-lab-source",
      "medcloud-lab-source-copy",
    ], `${at}.name`);
    const value = rowString(extension.value, `${at}.value`, budget, 120);
    return value === undefined ? undefined : {name, value};
  }).filter((extension) => extension !== undefined);
  out.sourceTags = expectArray(row.sourceTags, `${where}.sourceTags`, 16)
    .map((tag, i) => {
      const value = rowString(tag, `${where}.sourceTags[${i}]`, budget, 120);
      if (value !== undefined && !SOURCE_TAG_NAMES.has(value.split(":")[0])) {
        fail(`${where}.sourceTags[${i}]: tag not in whitelist`);
      }
      return value;
    })
    .filter((tag): tag is string => tag !== undefined);

  const app = expectObject(row.app, `${where}.app`);
  onlyKeys(app, ["categoryId", "decidedBy", "testKey", "column"],
    `${where}.app`);
  out.app = {
    categoryId: app.categoryId === null ?
      null :
      panelIdOf(app.categoryId, `${where}.app.categoryId`, budget),
    decidedBy: expectEnum(app.decidedBy, DECISIONS, `${where}.app.decidedBy`),
    testKey: rowString(app.testKey, `${where}.app.testKey`, budget) ?? "",
    column: rowString(app.column, `${where}.app.column`, budget) ?? "",
  };
  return out;
};

export interface NormalizedLabDataReport {
  report: Json;
  rowCount: number;
  /** MediCloud raw rows (empty when none were attached); stored in chunks. */
  rawRows: Json[];
  serverDroppedStrings: number;
  /** Panel ids outside PANEL_IDS, stored as "unknown". */
  serverUnknownPanels: number;
  /** SHA-256 of the payload, for de-duplicating a resend. Not stored. */
  submissionKey?: string;
}

/**
 * Validate and normalise a report body. Throws LabDataReportError with a
 * client-safe reason when the body is outside the contract, or when the
 * reporter's description looks like it carries an identifier.
 * @param {unknown} body - Parsed JSON body.
 * @return {NormalizedLabDataReport} The report to store.
 */
// ── MediCloud raw source rows (optional) ────────────────────────────────
// The app may attach the 雲端病歷 extension's raw IMUE0060 laboratory rows,
// narrowed in the browser to an allowlist (app: features/lab-data-report/
// utils/raw-lab-rows.ts). The same allowlist is enforced here: any other
// field is refused, every string is re-scanned, dates are relative days only.
export const MAX_RAW_ROWS = 5000;
const RAW_S02_TEXT = [
  "order_code", "order_name", "assay_item_name", "unit_data",
  "consult_value", "assay_mark", "assay_method", "assay_tp_cname",
  "inspect_mode", "data_mark", "hosp", "func_type",
] as const;
const RAW_FIELDS = {
  s02: {
    text: RAW_S02_TEXT as readonly string[],
    results: ["assay_value", "inspect_result", "memo_data"],
    dates: ["case_time", "real_inspect_date", "recipe_date"],
  },
  s03: {
    text: ["assaY_NAME"],
    results: ["assaY_VALUE"],
    dates: ["assaY_DATE"],
  },
} as const;
const RAW_SOURCES = ["s02", "s03"] as const;
export const RAW_ERRORS = [
  "NOT_AVAILABLE", "EXPIRED", "BUNDLE_MISMATCH", "PATIENT_MISMATCH",
  "PATIENT_UNVERIFIED", "CONTEXT_CHANGED", "REQUEST_IN_PROGRESS",
  "INVALID_REQUEST", "READ_FAILED", "EXTENSION_UNAVAILABLE", "NO_LAB_SOURCE",
] as const;
const RAW_DAY_LIMIT = 40000;

/**
 * One raw row, strictly: its source decides which fields may appear.
 * @param {unknown} raw - Submitted row.
 * @param {number} index - Position, for the rejection reason.
 * @param {boolean} includesValues - Whether the reporter attached values.
 * @param {ScanBudget} budget - Drop counter for this report.
 * @return {Json} The normalised row.
 */
const normalizeRawRow = (
  raw: unknown,
  index: number,
  includesValues: boolean,
  budget: ScanBudget,
): Json => {
  const where = `rawSource.rows[${index}]`;
  const row = expectObject(raw, where);
  onlyKeys(row, [
    "ref", "source", "ordinal", "dates", "fields", "results", "withheld",
  ], where);
  const source = expectEnum(row.source, RAW_SOURCES, `${where}.source`);
  const allowed = RAW_FIELDS[source];
  const out: Json = {
    ref: expectInteger(row.ref, `${where}.ref`, 1, MAX_RAW_ROWS),
    source,
  };
  if (row.ordinal !== undefined) {
    out.ordinal = expectInteger(row.ordinal, `${where}.ordinal`, 0, 10_000_000);
  }

  const dates = expectObject(row.dates, `${where}.dates`);
  onlyKeys(dates, allowed.dates, `${where}.dates`);
  const datesOut: Json = {};
  for (const [field, value] of Object.entries(dates)) {
    const at = `${where}.dates.${field}`;
    const date = expectObject(value, at);
    onlyKeys(date, ["day", "time"], at);
    const dateOut: Json = {
      day: expectInteger(date.day, `${at}.day`, -RAW_DAY_LIMIT, RAW_DAY_LIMIT),
    };
    if (date.time !== undefined) {
      if (typeof date.time !== "string" ||
        !/^\d{2}:\d{2}(:\d{2})?$/.test(date.time)) {
        fail(`${at}.time: expected HH:MM[:SS]`);
      }
      dateOut.time = date.time;
    }
    datesOut[field] = dateOut;
  }
  out.dates = datesOut;

  const fields = expectObject(row.fields, `${where}.fields`);
  onlyKeys(fields, allowed.text, `${where}.fields`);
  const fieldsOut: Json = {};
  for (const [field, value] of Object.entries(fields)) {
    const text = rowString(value, `${where}.fields.${field}`, budget,
      field === "consult_value" ? MAX_RANGE_TEXT : MAX_STRING);
    if (text !== undefined) fieldsOut[field] = text;
  }
  out.fields = fieldsOut;

  const results = expectObject(row.results, `${where}.results`);
  onlyKeys(results, allowed.results, `${where}.results`);
  if (!includesValues && Object.keys(results).length > 0) {
    fail(`${where}.results: values not attached`);
  }
  const resultsOut: Json = {};
  for (const [field, value] of Object.entries(results)) {
    const at = `${where}.results.${field}`;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) fail(`${at}: expected number`);
      resultsOut[field] = value;
      continue;
    }
    const text = resultString(value, at, budget);
    if (text !== undefined) resultsOut[field] = text;
  }
  out.results = resultsOut;

  const withheld = expectObject(row.withheld, `${where}.withheld`);
  onlyKeys(withheld, allowed.results, `${where}.withheld`);
  const withheldOut: Json = {};
  for (const [field, value] of Object.entries(withheld)) {
    withheldOut[field] =
      expectInteger(value, `${where}.withheld.${field}`, 0, 1_000_000);
  }
  out.withheld = withheldOut;
  return out;
};

/**
 * The raw-source block, strictly.
 * @param {unknown} value - Submitted block.
 * @param {boolean} includesValues - Whether the reporter attached values.
 * @param {ScanBudget} budget - Drop counter for this report.
 * @return {{header: Json, rows: Json[]}} Header (stored on the report) and
 *   rows (stored in chunks).
 */
const normalizeRawSource = (
  value: unknown,
  includesValues: boolean,
  budget: ScanBudget,
): {header: Json; rows: Json[]} => {
  const raw = expectObject(value, "rawSource");
  onlyKeys(raw, [
    "producer", "producerVersion", "rows", "s02Rows", "s03Rows",
    "endpointStatus", "truncatedRows", "droppedStrings", "unparsedDates",
    "unknownFields",
  ], "rawSource");
  expectEnum(raw.producer, ["medcloud2"] as const, "rawSource.producer");
  if (raw.producerVersion !== undefined &&
    (typeof raw.producerVersion !== "string" ||
      !/^[A-Za-z0-9._-]{1,32}$/.test(raw.producerVersion))) {
    fail("rawSource.producerVersion: unexpected value");
  }
  const status = expectObject(raw.endpointStatus, "rawSource.endpointStatus");
  onlyKeys(status, ["s02", "s03"], "rawSource.endpointStatus");
  const endpointStatus: Json = {};
  for (const [key, code] of Object.entries(status)) {
    endpointStatus[key] =
      expectInteger(code, `rawSource.endpointStatus.${key}`, 100, 599);
  }
  const unknownFields = expectArray(raw.unknownFields,
    "rawSource.unknownFields", 20)
    .map((name, i) => {
      if (typeof name !== "string" || !/^[A-Za-z0-9_]{1,40}$/.test(name)) {
        return fail(`rawSource.unknownFields[${i}]: unexpected value`);
      }
      return rowString(name, `rawSource.unknownFields[${i}]`, budget, 40);
    })
    .filter((name): name is string => name !== undefined);
  const rows = expectArray(raw.rows, "rawSource.rows", MAX_RAW_ROWS)
    .map((row, index) => normalizeRawRow(row, index, includesValues, budget));
  const count = (key: string) =>
    expectInteger(raw[key], `rawSource.${key}`, 0, 1_000_000);
  return {
    header: {
      producer: "medcloud2",
      ...(typeof raw.producerVersion === "string" &&
        {producerVersion: raw.producerVersion}),
      s02Rows: count("s02Rows"),
      s03Rows: count("s03Rows"),
      endpointStatus,
      truncatedRows: count("truncatedRows"),
      droppedStrings: count("droppedStrings"),
      unparsedDates: count("unparsedDates"),
      unknownFields,
    },
    rows,
  };
};

export const normalizeLabDataReport = (
  body: unknown,
): NormalizedLabDataReport => {
  const payload = expectObject(body, "body");
  onlyKeys(payload, [
    "schemaVersion", "problemType", "description", "includesValues", "scope",
    "context", "rows", "truncatedRows", "excludedNonLabRows",
    "droppedStrings", "submissionKey", "rawSource", "rawSourceError",
  ], "body");
  if (
    payload.submissionKey !== undefined &&
    (typeof payload.submissionKey !== "string" ||
      !/^[0-9a-f]{64}$/.test(payload.submissionKey))
  ) {
    fail("submissionKey: expected a SHA-256 hex digest");
  }
  if (payload.schemaVersion !== LAB_DATA_REPORT_SCHEMA_VERSION) {
    fail("schemaVersion: unsupported");
  }
  const budget: ScanBudget = {dropped: 0, unknownPanels: 0};

  if (typeof payload.description !== "string") {
    fail("description: expected string");
  }
  const description = (payload.description as string).trim();
  if (description.length > MAX_DESCRIPTION) {
    fail(`description: longer than ${MAX_DESCRIPTION}`);
  }
  const found: IdentifierKind[] = findDescriptionIdentifiers(description);
  if (found.length > 0) fail(`description-identifier:${found.join(",")}`);

  if (typeof payload.includesValues !== "boolean") {
    fail("includesValues: expected boolean");
  }

  const scope = expectObject(payload.scope, "scope");
  onlyKeys(scope, ["flaggedCategories", "categories"], "scope");
  const flaggedCategories = [...new Set(expectArray(
    scope.flaggedCategories, "scope.flaggedCategories", 30,
  ).map((id, i) => panelIdOf(id, `scope.flaggedCategories[${i}]`, budget)))];
  const categories = expectArray(scope.categories, "scope.categories", 30)
    .map((raw, i) => {
      const at = `scope.categories[${i}]`;
      const entry = expectObject(raw, at);
      onlyKeys(entry, ["categoryId", "rows"], at);
      return {
        categoryId: panelIdOf(entry.categoryId, `${at}.categoryId`, budget),
        rows: expectInteger(entry.rows, `${at}.rows`, 0, MAX_ROWS),
      };
    });

  const context = expectObject(payload.context, "context");
  onlyKeys(context, [
    "appVersion", "dataSource", "site", "language", "nameMode",
  ], "context");
  const appVersion = rowString(context.appVersion, "context.appVersion",
    budget, 40);
  const language = rowString(context.language, "context.language", budget, 16);

  const rows = expectArray(payload.rows, "rows", MAX_ROWS)
    .map((row, index) => normalizeRow(row, index, budget));
  if (rows.length === 0) fail("rows: empty");

  const rawSource = payload.rawSource === undefined ?
    undefined :
    normalizeRawSource(payload.rawSource, payload.includesValues === true,
      budget);
  const rawSourceError = payload.rawSourceError === undefined ?
    undefined :
    expectEnum(payload.rawSourceError, RAW_ERRORS, "rawSourceError");
  if (rawSource && rawSourceError) {
    fail("rawSourceError: raw rows are attached");
  }

  const report: Json = {
    schemaVersion: LAB_DATA_REPORT_SCHEMA_VERSION,
    problemType: expectEnum(payload.problemType, PROBLEM_TYPES, "problemType"),
    description,
    includesValues: payload.includesValues,
    scope: {flaggedCategories, categories},
    context: {
      appVersion: appVersion ?? "unknown",
      dataSource: expectEnum(
        context.dataSource, DATA_SOURCES, "context.dataSource",
      ),
      site: expectEnum(context.site, SITES, "context.site"),
      language: language ?? "unknown",
      nameMode: expectEnum(context.nameMode, NAME_MODES, "context.nameMode"),
    },
    rows,
    truncatedRows: expectInteger(
      payload.truncatedRows, "truncatedRows", 0, 1_000_000,
    ),
    excludedNonLabRows: expectInteger(
      payload.excludedNonLabRows, "excludedNonLabRows", 0, 1_000_000,
    ),
    droppedStrings: expectInteger(
      payload.droppedStrings, "droppedStrings", 0, 1_000_000,
    ),
    ...(rawSource && {rawSource: rawSource.header}),
    ...(rawSourceError && {rawSourceError}),
  };
  return {
    report,
    rowCount: rows.length,
    rawRows: rawSource?.rows ?? [],
    serverDroppedStrings: budget.dropped,
    serverUnknownPanels: budget.unknownPanels,
    ...(typeof payload.submissionKey === "string" &&
      {submissionKey: payload.submissionKey}),
  };
};

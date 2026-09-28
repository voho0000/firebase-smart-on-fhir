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

const onlyKeys = (value: Json, allowed: readonly string[], where: string) => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${where}.${key}: unexpected field`);
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

/**
 * A lab panel id (cbc, chem, urine …): a fixed app vocabulary.
 * @param {unknown} value - Submitted value.
 * @param {string} where - Field path for the rejection reason.
 * @return {string} The panel id.
 */
const categoryIdOf = (value: unknown, where: string): string =>
  typeof value === "string" && /^[a-z0-9-]{1,40}$/.test(value) ?
    value :
    fail(`${where}: expected a panel id`);

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

  out.category = expectArray(row.category, `${where}.category`, 8)
    .map((c, i) => rowString(c, `${where}.category[${i}]`, budget, 64))
    .filter((c): c is string => c !== undefined);
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
      rowString(app.categoryId, `${where}.app.categoryId`, budget, 40) ?? null,
    decidedBy: expectEnum(app.decidedBy, DECISIONS, `${where}.app.decidedBy`),
    testKey: rowString(app.testKey, `${where}.app.testKey`, budget) ?? "",
    column: rowString(app.column, `${where}.app.column`, budget) ?? "",
  };
  return out;
};

export interface NormalizedLabDataReport {
  report: Json;
  rowCount: number;
  serverDroppedStrings: number;
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
export const normalizeLabDataReport = (
  body: unknown,
): NormalizedLabDataReport => {
  const payload = expectObject(body, "body");
  onlyKeys(payload, [
    "schemaVersion", "problemType", "description", "includesValues", "scope",
    "context", "rows", "truncatedRows", "excludedNonLabRows",
    "droppedStrings", "submissionKey",
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
  const budget: ScanBudget = {dropped: 0};

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
  const flaggedCategories = expectArray(
    scope.flaggedCategories, "scope.flaggedCategories", 30,
  ).map((id, i) => categoryIdOf(id, `scope.flaggedCategories[${i}]`));
  const categories = expectArray(scope.categories, "scope.categories", 30)
    .map((raw, i) => {
      const at = `scope.categories[${i}]`;
      const entry = expectObject(raw, at);
      onlyKeys(entry, ["categoryId", "rows"], at);
      return {
        categoryId: categoryIdOf(entry.categoryId, `${at}.categoryId`),
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
  };
  return {
    report,
    rowCount: rows.length,
    serverDroppedStrings: budget.dropped,
    ...(typeof payload.submissionKey === "string" &&
      {submissionKey: payload.submissionKey}),
  };
};

// Server copy of the app's identifier scan (medical-note-smart-on-fhir
// features/lab-data-report/utils/identifier-scan.ts). The rules are the same
// on both sides and both test suites share the same vectors — change them
// together.
//
// Row text comes from the source and cannot be edited by the reporter: a
// match drops that one string. The reporter's own description can be edited,
// so a match there rejects the report with the reason.

export type IdentifierKind =
  | "national-id"
  | "masked-id"
  | "email"
  | "phone"
  | "full-date"
  | "long-number";

// Text is NFKC-normalised first, so full-width letters and digits are caught
// by the same ASCII patterns.
//
// Source strings and the reporter's note get the same patterns. There is no
// exception for the 10-digit 醫事機構代碼: it cannot be told apart from a
// chart or mobile number. The app takes it out of performer — the one field
// known to carry it — before it scans; anything left here is dropped.
const MONTH = "(?:0?[1-9]|1[0-2])";
const DAY = "(?:0?[1-9]|[12]\\d|3[01])";

const PATTERNS: ReadonlyArray<readonly [IdentifierKind, RegExp]> = [
  // 身分證／新式居留證: letter + 1/2/8/9 + 8 digits.
  ["national-id", /(?:^|[^A-Za-z0-9])[A-Za-z][1289]\d{8}(?!\d)/],
  // 舊式居留證: two letters + 8 digits.
  ["national-id", /(?:^|[^A-Za-z0-9])[A-Za-z][A-Da-d]\d{8}(?!\d)/],
  // Masked forms the bridges print, e.g. F203XXX511, A10040XXXX.
  ["masked-id", /(?:^|[^A-Za-z0-9])[A-Za-z]\d{2,6}[Xx*]{3,6}\d{0,4}(?!\d)/],
  ["email", /[\w.+-]+@[\w-]+\.[\w.-]+/],
  // Taiwan mobile: 0912-345-678, 0912345678, +886 912 345 678.
  [
    "phone",
    // eslint-disable-next-line max-len
    /(?:^|\D)(?:\+?886[-\s]?9\d{2}[-\s]?\d{3}[-\s]?\d{3}|09\d{2}[-\s]?\d{3}[-\s]?\d{3})(?!\d)/,
  ],
  // Western dates, including ISO timestamps and 年/月.
  [
    "full-date",
    new RegExp(
      // eslint-disable-next-line max-len
      `(?:^|\\D)(?:19|20)\\d{2}\\s*[-/.年]\\s*${MONTH}\\s*[-/.月]\\s*${DAY}(?!\\d)`,
    ),
  ],
  // ROC, any year 民國 0–119, zero-padded or not: 65/03/12, 079-3-12,
  // 65年3月12日. Month and day must be valid ("1/80/160" is a titre).
  [
    "full-date",
    new RegExp(
      // eslint-disable-next-line max-len
      `(?:^|\\D)(?:0?\\d{1,2}|1[01]\\d)\\s*[-/年]\\s*${MONTH}\\s*[-/月]\\s*${DAY}(?!\\d)`,
    ),
  ],
  // ROC with dots only in the two-digit form (65.03.12, 079.03.12), so a
  // version ("0.12.13") or a decimal range is not a date.
  [
    "full-date",
    // eslint-disable-next-line max-len
    /(?:^|[^\d.])(?:0?\d{2}|1[01]\d)\.(?:0[1-9]|1[0-2])\.(?:0[1-9]|[12]\d|3[01])(?![\d.])/,
  ],
  // Any 7+ digit run: a chart number, an ID without its letter, a phone.
  ["long-number", /\d{7,}/],
];

export const findRowIdentifier = (
  text: string | undefined | null,
): IdentifierKind | null => {
  if (!text) return null;
  const normalized = String(text).normalize("NFKC");
  for (const [kind, pattern] of PATTERNS) {
    if (pattern.test(normalized)) return kind;
  }
  return null;
};

export const findDescriptionIdentifiers = (
  text: string | undefined | null,
): IdentifierKind[] => {
  if (!text) return [];
  const normalized = String(text).normalize("NFKC");
  const kinds = new Set<IdentifierKind>();
  for (const [kind, pattern] of PATTERNS) {
    if (pattern.test(normalized)) kinds.add(kind);
  }
  return [...kinds];
};

// A source result string is stored only when it is a short result, not
// prose. A CJK character weighs 3; sentence punctuation marks narrative.
export const MAX_RESULT_TEXT_WEIGHT = 40;

export const isShortResultText = (text: string): boolean => {
  const normalized = text.normalize("NFKC").trim();
  if (/[\uFF0C\u3002\uFF1B\uFF01\uFF1F]/.test(text)) return false;
  if (/[.!?]\s+\S/.test(normalized)) return false;
  let weight = 0;
  for (const char of normalized) {
    weight += /[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/.test(char) ? 3 : 1;
    if (weight > MAX_RESULT_TEXT_WEIGHT) return false;
  }
  return true;
};

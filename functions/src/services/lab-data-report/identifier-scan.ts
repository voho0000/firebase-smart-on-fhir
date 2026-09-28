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
const ROW_PATTERNS: ReadonlyArray<readonly [IdentifierKind, RegExp]> = [
  // 身分證／新式居留證: letter + 1/2/8/9 + 8 digits.
  ["national-id", /(?:^|[^A-Za-z0-9])[A-Za-z][1289]\d{8}(?!\d)/],
  // 舊式居留證: two letters + 8 digits.
  ["national-id", /(?:^|[^A-Za-z0-9])[A-Za-z][A-Da-d]\d{8}(?!\d)/],
  // Masked forms the bridges print, e.g. F203XXX511, A10040XXXX.
  ["masked-id", /(?:^|[^A-Za-z0-9])[A-Za-z]\d{2,6}[Xx*]{3,6}\d{0,4}(?!\d)/],
  ["email", /[\w.+-]+@[\w-]+\.[\w.-]+/],
  // Taiwan mobile written as a phone number. A bare 10-digit run is not
  // matched: performer strings carry 10-digit 醫事機構代碼.
  [
    "phone",
    // eslint-disable-next-line max-len
    /(?:^|\D)(?:\+?886[-\s]?9\d{2}[-\s]?\d{3}[-\s]?\d{3}|09\d{2}[-\s]\d{3}[-\s]?\d{3})(?!\d)/,
  ],
  // Western dates, including ISO timestamps and 年/月.
  [
    "full-date",
    /(?:^|\D)(?:19|20)\d{2}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}(?!\d)/,
  ],
  // ROC (民國 80–119) dates, only with / or 年.
  [
    "full-date",
    /(?:^|\D)(?:[89]\d|1[01]\d)\s*[/年]\s*\d{1,2}\s*[/月]\s*\d{1,2}(?!\d)/,
  ],
];

// Reporter-typed text only: a bare mobile number or any 7+ digit run (chart
// number). Source rows legitimately carry 10-digit institution codes.
const DESCRIPTION_PATTERNS: ReadonlyArray<readonly [IdentifierKind, RegExp]> =
  [
    ...ROW_PATTERNS,
    ["phone", /(?:^|\D)09\d{8}(?!\d)/],
    ["long-number", /\d{7,}/],
  ];

export const findRowIdentifier = (
  text: string | undefined | null,
): IdentifierKind | null => {
  if (!text) return null;
  const normalized = String(text).normalize("NFKC");
  for (const [kind, pattern] of ROW_PATTERNS) {
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
  for (const [kind, pattern] of DESCRIPTION_PATTERNS) {
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

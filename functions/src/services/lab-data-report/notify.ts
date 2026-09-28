// "A new lab-data report arrived" mail to the developer.
//
// Metadata only: report id, ticked panels, problem type, row counts, data
// source. Never the reporter's note, hospitals, test names or values — a mail
// outlives the report (which is deleted once handled, 90 days at most), so
// the clinical content stays in Firestore and is read in the /lab-reports
// viewer the link opens.
import * as logger from "firebase-functions/logger";
import {Resend} from "resend";

export const LAB_REPORT_NOTIFY_TO = "voho0000@gmail.com";
const DEFAULT_VIEWER_URL = "https://mediprisma.tw/app/lab-reports";
const SEND_TIMEOUT_MS = 5000;

const PANEL_LABELS: Readonly<Record<string, string>> = {
  cbc: "血液",
  coag: "凝血",
  chem: "生化",
  endocrine: "內分泌",
  lipid: "血脂",
  glucose: "血糖",
  hep: "BC肝",
  tumor: "癌症",
  urine: "尿液",
  bloodgas: "血氣",
  serology: "病毒抗原",
  microbio: "微生物",
  other: "其他",
};

const PROBLEM_LABELS: Readonly<Record<string, string>> = {
  "wrong-panel": "分錯類",
  "split-column": "同項拆欄",
  "duplicate": "重複值",
  "value-unit": "單位或數值",
  "name": "名稱",
  "other": "其他",
  "unspecified": "未選類型",
};

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  medcloud: "雲端病歷",
  nhi: "健康存摺",
  smart: "SMART",
  demo: "示範資料",
  import: "匯入",
  unknown: "未知",
};

export interface LabReportNotice {
  reportId: string;
  problemType: string;
  flaggedCategories: string[];
  categories: Array<{categoryId: string; rows: number}>;
  rowCount: number;
  includesValues: boolean;
  dataSource: string;
  site: string;
  hasDescription: boolean;
}

const panel = (id: string): string => PANEL_LABELS[id] ?? id;

const escapeHtml = (text: string): string => text
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

/**
 * Subject and body of the notice. Pure, so the "no clinical content" promise
 * is testable.
 * @param {LabReportNotice} notice - Report metadata.
 * @param {string} viewerUrl - The /lab-reports viewer.
 * @return {{subject: string, text: string, html: string}} The mail.
 */
export const composeLabReportNotice = (
  notice: LabReportNotice,
  viewerUrl: string = process.env.LAB_REPORT_VIEWER_URL || DEFAULT_VIEWER_URL,
): {subject: string; text: string; html: string} => {
  const flagged = notice.flaggedCategories.length > 0 ?
    notice.flaggedCategories.map(panel).join("、") :
    "未勾選分類";
  const problem = PROBLEM_LABELS[notice.problemType] ?? notice.problemType;
  const link = `${viewerUrl}?id=${encodeURIComponent(notice.reportId)}`;
  const lines: Array<[string, string]> = [
    ["回報編號", notice.reportId],
    ["有問題的分類", flagged],
    ["問題類型", problem],
    ["檢驗列數", `${notice.rowCount} 列（${notice.categories
      .map((entry) => `${panel(entry.categoryId)} ${entry.rows}`)
      .join("、")}）`],
    ["附數值", notice.includesValues ? "是" : "否"],
    ["資料來源", `${SOURCE_LABELS[notice.dataSource] ?? notice.dataSource}` +
      (notice.site !== "unknown" ? ` · ${notice.site}` : "")],
    ["說明", notice.hasDescription ? "有（請在檢視頁查看）" : "無"],
  ];
  const subject =
    `[檢驗資料回報] ${flagged} · ${problem} · ${notice.rowCount} 列`;
  const text = [
    "有一份新的檢驗資料問題回報。",
    "",
    ...lines.map(([label, value]) => `${label}：${value}`),
    "",
    `查看與處理：${link}`,
    "",
    "這封信只有摘要；檢驗內容在檢視頁，問題處理完請在該頁刪除。",
  ].join("\n");
  const html = [
    "<p>有一份新的檢驗資料問題回報。</p>",
    "<table cellpadding=\"4\" style=\"border-collapse:collapse\">",
    ...lines.map(([label, value]) =>
      `<tr><th align="left" style="color:#555">${escapeHtml(label)}</th>` +
      `<td>${escapeHtml(value)}</td></tr>`),
    "</table>",
    `<p><a href="${escapeHtml(link)}">查看與處理這份回報</a></p>`,
    "<p style=\"color:#777;font-size:12px\">這封信只有摘要；檢驗內容在檢視頁，" +
      "問題處理完請在該頁刪除。</p>",
  ].join("");
  return {subject, text, html};
};

/**
 * Send the notice. Never throws: a mail hiccup must not fail a report that is
 * already stored — the viewer lists it either way.
 * @param {LabReportNotice} notice - Report metadata.
 * @return {Promise<boolean>} Whether the mail was accepted.
 */
export const sendLabReportNotice = async (
  notice: LabReportNotice,
): Promise<boolean> => {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logger.info("RESEND_API_KEY not set — lab-data report notice skipped", {
      reportId: notice.reportId,
    });
    return false;
  }
  const {subject, text, html} = composeLabReportNotice(notice);
  try {
    const send = new Resend(apiKey).emails.send({
      from: "onboarding@resend.dev",
      to: [LAB_REPORT_NOTIFY_TO],
      subject,
      text,
      html,
    });
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("notice timed out")), SEND_TIMEOUT_MS));
    const {error} = await Promise.race([send, timeout]);
    if (error) {
      logger.error("Lab-data report notice rejected", {
        reportId: notice.reportId, message: error.message,
      });
      return false;
    }
    return true;
  } catch (error) {
    logger.error("Lab-data report notice failed", {
      reportId: notice.reportId,
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
};

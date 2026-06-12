/**
 * Get localized label for issue type.
 * @param {string} type - Issue type code.
 * @return {string} Localized label.
 */
export function getIssueTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    bug: "功能錯誤 (Bug)",
    ui: "UI/UX 問題",
    performance: "效能問題 (Performance)",
    feature: "功能建議 (Feature Request)",
    other: "其他 (Other)",
  };
  return labels[type] || type;
}

/**
 * Get localized label for severity level.
 * @param {string} severity - Severity level code.
 * @return {string} Localized label.
 */
export function getSeverityLabel(severity: string): string {
  const labels: Record<string, string> = {
    low: "低 (Low)",
    medium: "中 (Medium)",
    high: "高 (High)",
    critical: "緊急 (Critical)",
  };
  return labels[severity] || severity;
}

/**
 * Generate HTML email content for feedback.
 * @param {string} email - Reporter email.
 * @param {string} issueType - Issue type.
 * @param {string} severity - Severity level.
 * @param {string} description - Issue description.
 * @param {string | undefined} steps - Steps to reproduce.
 * @param {object} systemInfo - System information.
 * @return {string} HTML email content.
 */
export function generateEmailHTML(
  email: string,
  issueType: string,
  severity: string,
  description: string,
  steps: string | undefined,
  systemInfo: {
    timestamp: string;
    userAgent: string;
    screenResolution: string;
    language: string;
    currentPath: string;
    fhirServerUrl: string;
    patientId: string;
  },
): string {
  const issueTypeLabel = getIssueTypeLabel(issueType);
  const severityLabel = getSeverityLabel(severity);
  const timestampFormatted = new Date(
    systemInfo.timestamp,
  ).toLocaleString("zh-TW", {timeZone: "Asia/Taipei"});

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: Arial, sans-serif;
      line-height: 1.6;
      color: #333;
    }
    .container {
      max-width: 600px;
      margin: 0 auto;
      padding: 20px;
    }
    .header {
      background: #3b82f6;
      color: white;
      padding: 20px;
      border-radius: 8px 8px 0 0;
    }
    .content {
      background: #f9fafb;
      padding: 20px;
      border: 1px solid #e5e7eb;
    }
    .section { margin-bottom: 20px; }
    .label { font-weight: bold; color: #1f2937; }
    .badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 600;
    }
    .badge-bug { background: #fee2e2; color: #991b1b; }
    .badge-ui { background: #dbeafe; color: #1e40af; }
    .badge-performance { background: #fef3c7; color: #92400e; }
    .badge-feature { background: #d1fae5; color: #065f46; }
    .badge-other { background: #e5e7eb; color: #374151; }
    .badge-low { background: #d1fae5; color: #065f46; }
    .badge-medium { background: #fef3c7; color: #92400e; }
    .badge-high { background: #fed7aa; color: #9a3412; }
    .badge-critical { background: #fee2e2; color: #991b1b; }
    .system-info {
      background: white;
      padding: 15px;
      border-radius: 6px;
      font-size: 13px;
    }
    .footer {
      text-align: center;
      padding: 20px;
      color: #6b7280;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2 style="margin: 0;">🐛 醫療筆記系統 - 問題回報</h2>
      <p style="margin: 5px 0 0 0; opacity: 0.9;">
        Medical Note System - Issue Report
      </p>
    </div>
    
    <div class="content">
      <div class="section">
        <span class="label">回報者 Email:</span> ${email}
      </div>
      
      <div class="section">
        <span class="label">問題類型:</span> 
        <span class="badge badge-${issueType}">${issueTypeLabel}</span>
      </div>
      
      <div class="section">
        <span class="label">嚴重程度:</span> 
        <span class="badge badge-${severity}">${severityLabel}</span>
      </div>
      
      <div class="section">
        <span class="label">問題描述:</span>
        <div style="
          margin-top: 8px;
          white-space: pre-wrap;
          background: white;
          padding: 12px;
          border-radius: 6px;
        ">${description}</div>
      </div>
      
      ${steps ? `
      <div class="section">
        <span class="label">重現步驟:</span>
        <div style="
          margin-top: 8px;
          white-space: pre-wrap;
          background: white;
          padding: 12px;
          border-radius: 6px;
        ">${steps}</div>
      </div>
      ` : ""}
      
      <div class="section">
        <span class="label">系統資訊:</span>
        <div class="system-info">
          <div><strong>時間:</strong> ${timestampFormatted}</div>
          <div><strong>瀏覽器:</strong> ${systemInfo.userAgent}</div>
          <div><strong>螢幕解析度:</strong> ${systemInfo.screenResolution}</div>
          <div><strong>語言:</strong> ${systemInfo.language}</div>
          <div><strong>當前頁面:</strong> ${systemInfo.currentPath}</div>
          <div><strong>FHIR Server:</strong> ${systemInfo.fhirServerUrl}</div>
          <div><strong>患者 ID:</strong> ${systemInfo.patientId}</div>
        </div>
      </div>
    </div>
    
    <div class="footer">
      <p>此郵件由 MediPrisma 系統自動發送</p>
      <p>This email was automatically sent by MediPrisma system</p>
    </div>
  </div>
</body>
</html>
`;
}

/**
 * Generate plain text email content for feedback.
 * @param {string} email - Reporter email.
 * @param {string} issueType - Issue type.
 * @param {string} severity - Severity level.
 * @param {string} description - Issue description.
 * @param {string | undefined} steps - Steps to reproduce.
 * @param {object} systemInfo - System information.
 * @return {string} Plain text email content.
 */
export function generatePlainText(
  email: string,
  issueType: string,
  severity: string,
  description: string,
  steps: string | undefined,
  systemInfo: {
    timestamp: string;
    userAgent: string;
    screenResolution: string;
    language: string;
    currentPath: string;
    fhirServerUrl: string;
    patientId: string;
  },
): string {
  const issueTypeLabel = getIssueTypeLabel(issueType);
  const severityLabel = getSeverityLabel(severity);
  const timestampFormatted = new Date(
    systemInfo.timestamp,
  ).toLocaleString("zh-TW", {timeZone: "Asia/Taipei"});

  return `
醫療筆記系統 - 問題回報
Medical Note System - Issue Report

回報者 Email: ${email}
問題類型: ${issueTypeLabel}
嚴重程度: ${severityLabel}

問題描述:
${description}

${steps ? `重現步驟:\n${steps}\n` : ""}

系統資訊:
- 時間: ${timestampFormatted}
- 瀏覽器: ${systemInfo.userAgent}
- 螢幕解析度: ${systemInfo.screenResolution}
- 語言: ${systemInfo.language}
- 當前頁面: ${systemInfo.currentPath}
- FHIR Server: ${systemInfo.fhirServerUrl}
- 患者 ID: ${systemInfo.patientId}

---
此郵件由 MediPrisma 系統自動發送
This email was automatically sent by MediPrisma system
`;
}

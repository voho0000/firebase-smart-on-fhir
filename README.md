# Firebase SMART on FHIR

Firebase Cloud Functions 專案，提供 AI 服務的 proxy endpoints，整合 OpenAI、Google Gemini 和 Perplexity API，專為醫療應用場景設計。

## 功能特色

- **OpenAI Chat Completion Proxy** - 支援 GPT 模型的對話完成功能
- **Google Gemini Chat Proxy** - 整合 Google Gemini AI 對話服務
- **Whisper 語音轉文字** - OpenAI Whisper API 的語音辨識服務
- **Perplexity 醫療文獻搜尋** - 專為醫療文獻搜尋優化的 AI 搜尋服務
- **使用者回饋系統** - 收集並處理使用者回饋

## 技術架構

- **Runtime**: Node.js 22
- **Framework**: Firebase Functions v2
- **Language**: TypeScript
- **AI SDKs**: 
  - Vercel AI SDK
  - OpenAI SDK
  - Google Generative AI SDK
- **主要依賴**:
  - `firebase-admin` - Firebase 管理功能
  - `firebase-functions` - Cloud Functions 框架
  - `ai` - Vercel AI SDK
  - `@ai-sdk/openai` - OpenAI 整合
  - `@ai-sdk/google` - Google AI 整合
  - `axios` - HTTP 客戶端
  - `resend` - 郵件服務

## 專案結構

```
firebase-smart-on-fhir/
├── functions/
│   ├── src/
│   │   ├── config/          # 配置檔案
│   │   ├── middleware/      # 中介軟體 (CORS, 錯誤處理)
│   │   ├── services/        # 各種 AI 服務處理器
│   │   │   ├── openai/      # OpenAI 服務
│   │   │   ├── gemini/      # Gemini 服務
│   │   │   ├── whisper/     # Whisper 語音服務
│   │   │   ├── perplexity/  # Perplexity 搜尋服務
│   │   │   └── feedback/    # 回饋處理服務
│   │   ├── types/           # TypeScript 型別定義
│   │   └── utils/           # 工具函式
│   ├── package.json
│   └── tsconfig.json
├── firebase.json            # Firebase 配置
├── firestore.rules          # Firestore 安全規則
└── README.md
```

## 環境設定

### 必要條件

- Node.js 22 或更高版本
- Firebase CLI
- Firebase 專案

### 安裝步驟

1. 安裝 Firebase CLI（如果尚未安裝）:
```bash
npm install -g firebase-tools
```

2. 登入 Firebase:
```bash
firebase login
```

3. 安裝專案依賴:
```bash
cd functions
npm install
```

### 環境變數設定

此專案使用 Firebase Secret Manager 管理敏感資訊。需要設定以下 secrets:

```bash
firebase functions:secrets:set OPENAI_API_KEY
firebase functions:secrets:set GEMINI_API_KEY
firebase functions:secrets:set PERPLEXITY_API_KEY
firebase functions:secrets:set RESEND_API_KEY
```

## 開發指令

```bash
# 進入 functions 目錄
cd functions

# 程式碼檢查
npm run lint

# 編譯 TypeScript
npm run build

# 監聽模式編譯
npm run build:watch

# 本地模擬器
npm run serve

# 互動式 shell
npm run shell
```

## 部署

### 部署所有 Functions

```bash
npm run deploy
```

或使用 Firebase CLI:

```bash
firebase deploy --only functions
```

### 部署特定 Function

```bash
firebase deploy --only functions:proxyWhisper
firebase deploy --only functions:proxyGeminiChat
firebase deploy --only functions:proxyChatCompletion
firebase deploy --only functions:proxyPerplexitySearch
firebase deploy --only functions:sendFeedback
```

## API Endpoints

部署後，以下 endpoints 將可用:

- `POST /proxyWhisper` - Whisper 語音轉文字
- `POST /proxyGeminiChat` - Gemini 對話
- `POST /proxyChatCompletion` - OpenAI Chat Completion
- `POST /proxyPerplexitySearch` - Perplexity 醫療搜尋
- `POST /sendFeedback` - 提交使用者回饋

詳細的 API 使用說明請參考:
- [Perplexity API 使用說明](./PERPLEXITY_API_USAGE.md)
- [Streaming 使用說明](./STREAMING_USAGE.md)
- [Vercel AI SDK 整合說明](./VERCEL_AI_SDK_INTEGRATION.md)

## Firestore 資料結構

### 使用者資料
- `users/{userId}` - 使用者基本資料
- `users/{userId}/usage/{date}` - 使用量統計
- `users/{userId}/chatTemplates/{templateId}` - 聊天模板
- `users/{userId}/clinicalInsightPanels/{panelId}` - 臨床洞察面板
- `users/{userId}/chats/{chatId}` - 聊天記錄

### 共享資料
- `sharedPrompts/{promptId}` - 共享提示詞

## 安全性

- 所有 endpoints 都包含 CORS 保護
- 使用 Firebase Secret Manager 管理 API keys
- Firestore 規則確保使用者只能存取自己的資料
- 共享提示詞支援公開讀取，但只有作者可以修改/刪除

## 監控與日誌

查看 Function 日誌:

```bash
npm run logs
```

或使用 Firebase Console 查看即時日誌和效能監控。

## 效能配置

- **最大實例數**: 10
- **超時時間**: 300 秒（AI endpoints）/ 60 秒（feedback）
- **記憶體配置**: 1GiB（AI endpoints）/ 512MiB（feedback）



## 聯絡資訊

如有問題或建議，請聯繫專案維護者。

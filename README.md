# Firebase SMART on FHIR

Firebase Cloud Functions 專案，提供 AI 服務的 proxy endpoints，整合 OpenAI、Google Gemini 和 Perplexity API，專為醫療應用場景設計。

## 功能特色

- **OpenAI Chat Completion Proxy** - 支援 GPT 模型的對話完成功能
- **Google Gemini Chat Proxy** - 整合 Google Gemini AI 對話服務
- **Anthropic Claude Chat Proxy** - Claude Messages API passthrough（含 SSE streaming）
- **BYO OpenAI-compatible Gateway** - 讓使用者以自己的 API key 連接經白名單核准、但不支援瀏覽器 CORS 的 HTTPS provider
- **Whisper 語音轉文字** - OpenAI Whisper API 的語音辨識服務
- **Perplexity 醫療文獻搜尋** - 專為醫療文獻搜尋優化的 AI 搜尋服務
- **使用者回饋系統** - 收集並處理使用者回饋
- **Dev / Prod 雙組 Functions** - 同一份程式碼匯出兩組 endpoints；`dev-*` 組供 localhost 開發驗證，正式組 URL 永遠不受開發影響

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
│   │   ├── middleware/      # 中介軟體 (CORS, App Check, 認證, 配額, 錯誤處理)
│   │   ├── services/        # 各種 AI 服務處理器
│   │   │   ├── openai/      # OpenAI 服務
│   │   │   ├── gemini/      # Gemini 服務
│   │   │   ├── claude/      # Claude 服務
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
firebase functions:secrets:set ANTHROPIC_API_KEY
firebase functions:secrets:set RESEND_API_KEY
```

Secrets 綁在 `setGlobalOptions`，dev 組與正式組共用同一組，無需重複設定。
`proxyOpenAiCompatibleGateway` 會以 `secrets: []` 覆寫全域設定，不會取得上述 owner-funded keys。

BYO Gateway 對使用者公開支援 NVIDIA API Catalog、OpenRouter 與 Cerebras。若要改用其他可信 provider，設定逗號分隔的精確 API Base URL（設定後會取代預設清單）：

```bash
OPENAI_COMPATIBLE_GATEWAY_BASE_URLS=https://integrate.api.nvidia.com/v1,https://openrouter.ai/api/v1,https://api.cerebras.ai/v1,https://approved-provider.example/v1
```

只接受公開 HTTPS hostname、443 port、`models` 與 `chat/completions`；不接受任意 URL、IP、redirect、query 或 fragment。
Cerebras 請求會將相容 SDK 常用的 `max_tokens` 正規化成目前 API 使用的 `max_completion_tokens`。

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

### Dev / Prod 雙組架構（2026-07-05 起）

`index.ts` 把同一批 handler 匯出兩次：六個正式 proxy functions 加上 feedback（一共七個，既有 URL 不變）＋一個 `dev` group（部署為 `dev-proxyGeminiChat` 等，各有獨立 URL）。兩組差異只在建構時參數：

| | 正式組 | dev 組 |
|---|---|---|
| CORS 白名單 | `ALLOWED_ORIGINS` env（未設＝全放行） | 寫死 `localhost:3001` / `127.0.0.1:3001` |
| App Check | `APPCHECK_ENFORCE` env（目前 log-only） | 同左；要預演 enforce 時把 `DEV_HANDLER_OPTIONS.appCheckEnforce` 改 `true` |
| maxInstances | 10（全域） | 2（限制失控迴圈的燒錢上限） |

**合約變更（新 header、App Check enforce 等）一律 dev-first**：`deploy:dev` → 本機（app repo 的 `.env.local` 指向 `dev-*` URL）驗證 → `deploy:prod`。正式環境全程不動。

注意：env（`.env` / `ALLOWED_ORIGINS` / `APPCHECK_ENFORCE`）是整個 codebase 部署時共用的，**兩組不可能靠 env 區分**——per-group 設定必須走 `withCorsAndErrorHandling(handler, {origins, appCheckEnforce})` 的建構參數。

### 部署指令

```bash
# 只部署 dev 組（完全不碰正式六個）
npm run deploy:dev

# 只部署正式六個（明確列名，永遠碰不到 dev 組）
npm run deploy:prod

# 全部（含 dev 組）
npm run deploy
```

### 部署特定 Function

```bash
firebase deploy --only functions:proxyGeminiChat        # 單一正式 function
firebase deploy --only functions:dev                    # 整個 dev 組
```

## API Endpoints

部署後，以下 endpoints 將可用（dev 組為同名加 `dev-` 前綴，各有獨立 URL）:

- `POST /proxyWhisper` - Whisper 語音轉文字
- `POST /proxyGeminiChat` - Gemini 對話
- `POST /proxyChatCompletion` - OpenAI Chat Completion
- `POST /proxyClaudeChat` - Claude 對話（Messages API passthrough）
- `POST /proxyPerplexitySearch` - Perplexity 醫療搜尋
- `GET|POST /proxyOpenAiCompatibleGateway` - 使用者自備 key 的受限 OpenAI-compatible Gateway
- `POST /sendFeedback` - 提交使用者回饋

### BYO OpenAI-compatible Gateway contract

Gateway 保留 `Authorization` 給 Firebase ID token，使用者的 provider key 使用獨立 header，且不儲存：

```text
Authorization: Bearer <Firebase ID token>
X-Firebase-AppCheck: <App Check token>
X-Upstream-Base-URL: https://integrate.api.nvidia.com/v1
X-Upstream-Path: models | chat/completions
X-Upstream-API-Key: <user-owned provider key>
```

- `models` 必須用 `GET`；`chat/completions` 必須用 `POST`。
- Chat JSON 與 SSE response 原樣轉送，包含 provider-specific reasoning fields。
- Production Gateway 強制 App Check、Firebase Auth、per-uid quota 與精確 CORS origin。
- Prompt、response 與 provider key 會在當次請求中經過 Firebase／Google Cloud；不得把此模式描述為 browser-direct。

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

- 所有 endpoints 都包含 CORS 保護（dev 組鎖 localhost；正式組讀 `ALLOWED_ORIGINS`）
- 所有 proxy 要求 Firebase ID token（匿名或登入），並以 Firestore transaction 做 per-uid 每日配額
- BYO Gateway 另有 `gatewayCount` quota，且 upstream URL 使用精確白名單以避免 SSRF／通用轉送器
- 一般 proxy 的 App Check（`X-Firebase-AppCheck`）預設為 log-only；正式 BYO Gateway 則個別強制驗證
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

- **最大實例數**: 10（正式組）/ 2（dev 組）
- **超時時間**: 300 秒（AI endpoints）/ 60 秒（feedback）
- **記憶體配置**: 1GiB（AI endpoints）/ 512MiB（feedback）



## 聯絡資訊

如有問題或建議，請聯繫專案維護者。

# Perplexity API 使用說明

## 概述

此服務提供 Perplexity AI 搜尋功能的 Firebase proxy，專為醫療文獻搜尋優化。

## Endpoint

```
POST https://YOUR_PROJECT_ID.cloudfunctions.net/proxyPerplexitySearch
```

將 `YOUR_PROJECT_ID` 替換為你的 Firebase 專案 ID。

## 認證

所有請求都需要在 header 中包含 client key：

```
X-Client-Key: your-client-key
```

## 請求格式

### Headers

```
Content-Type: application/json
X-Client-Key: your-client-key
```

### Request Body

```typescript
{
  query: string,              // 必填：搜尋查詢內容
  searchDepth?: "basic" | "advanced",  // 選填：搜尋深度，預設 "basic"
  maxTokens?: number,         // 選填：最大 token 數，預設 1500
  temperature?: number,       // 選填：溫度參數，預設 0.2
  topP?: number,             // 選填：Top-p 參數，預設 0.9
  searchDomainFilter?: string[]  // 選填：搜尋網域過濾，預設醫療網站
}
```

### 參數說明

- **query** (必填)
  - 類型：`string`
  - 說明：要搜尋的醫療問題或關鍵字
  - 範例：`"Latest treatment guidelines for Type 2 Diabetes"`

- **searchDepth** (選填)
  - 類型：`"basic"` | `"advanced"`
  - 預設值：`"basic"`
  - 說明：
    - `"basic"`: 使用 `sonar` 模型，快速且經濟
    - `"advanced"`: 使用 `sonar-pro` 模型，更全面但較貴

- **maxTokens** (選填)
  - 類型：`number`
  - 預設值：`1500`
  - 說明：回應的最大 token 數量

- **temperature** (選填)
  - 類型：`number`
  - 預設值：`0.2`
  - 範圍：`0.0 - 1.0`
  - 說明：控制回應的隨機性，較低值更保守

- **topP** (選填)
  - 類型：`number`
  - 預設值：`0.9`
  - 範圍：`0.0 - 1.0`
  - 說明：核心採樣參數

- **searchDomainFilter** (選填)
  - 類型：`string[]`
  - 預設值：`["pubmed.ncbi.nlm.nih.gov", "nih.gov", "who.int", "uptodate.com"]`
  - 說明：限制搜尋的網域，預設為醫療權威網站

## 回應格式

### 成功回應 (200 OK)

```typescript
{
  success: true,
  content: string,      // AI 生成的回應內容
  citations: string[]   // 引用來源的 URL 列表
}
```

### 錯誤回應

```typescript
{
  success: false,
  content: "",
  error: string        // 錯誤訊息
}
```

### HTTP 狀態碼

- `200` - 成功
- `400` - 請求格式錯誤（例如缺少 query）
- `401` - 認證失敗（client key 無效）
- `405` - 方法不允許（只接受 POST）
- `500` - 伺服器錯誤（API key 未配置或 Perplexity API 錯誤）

## 使用範例

### JavaScript/TypeScript (Fetch API)

```typescript
async function searchMedicalLiterature(query: string) {
  const response = await fetch(
    'https://YOUR_PROJECT_ID.cloudfunctions.net/proxyPerplexitySearch',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Key': 'your-client-key'
      },
      body: JSON.stringify({
        query: query,
        searchDepth: 'basic'
      })
    }
  );

  const data = await response.json();
  
  if (data.success) {
    console.log('回應內容:', data.content);
    console.log('引用來源:', data.citations);
    return data;
  } else {
    console.error('錯誤:', data.error);
    throw new Error(data.error);
  }
}

// 使用範例
searchMedicalLiterature('What are the latest guidelines for managing hypertension?');
```

### React 範例

```typescript
import { useState } from 'react';

function PerplexitySearch() {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleSearch = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(
        'https://YOUR_PROJECT_ID.cloudfunctions.net/proxyPerplexitySearch',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Client-Key': process.env.REACT_APP_CLIENT_KEY
          },
          body: JSON.stringify({
            query: query,
            searchDepth: 'basic'
          })
        }
      );

      const data = await response.json();

      if (data.success) {
        setResult(data);
      } else {
        setError(data.error);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="輸入醫療問題..."
      />
      <button onClick={handleSearch} disabled={loading}>
        {loading ? '搜尋中...' : '搜尋'}
      </button>

      {error && <div className="error">{error}</div>}

      {result && (
        <div>
          <h3>回應：</h3>
          <p>{result.content}</p>
          
          {result.citations && result.citations.length > 0 && (
            <>
              <h4>引用來源：</h4>
              <ul>
                {result.citations.map((citation, index) => (
                  <li key={index}>
                    <a href={citation} target="_blank" rel="noopener noreferrer">
                      {citation}
                    </a>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
```

### cURL 範例

```bash
curl -X POST \
  https://YOUR_PROJECT_ID.cloudfunctions.net/proxyPerplexitySearch \
  -H 'Content-Type: application/json' \
  -H 'X-Client-Key: your-client-key' \
  -d '{
    "query": "What are the latest treatment options for COVID-19?",
    "searchDepth": "advanced"
  }'
```

## 進階使用

### 自訂搜尋網域

```typescript
const response = await fetch(endpoint, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Client-Key': 'your-client-key'
  },
  body: JSON.stringify({
    query: 'Latest cancer research',
    searchDomainFilter: [
      'pubmed.ncbi.nlm.nih.gov',
      'cancer.gov',
      'nature.com',
      'thelancet.com'
    ]
  })
});
```

### 使用進階搜尋模式

```typescript
const response = await fetch(endpoint, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Client-Key': 'your-client-key'
  },
  body: JSON.stringify({
    query: 'Comprehensive review of immunotherapy for melanoma',
    searchDepth: 'advanced',  // 使用 sonar-pro 模型
    maxTokens: 2000,
    temperature: 0.1  // 更保守的回應
  })
});
```

## 錯誤處理

```typescript
async function searchWithErrorHandling(query: string) {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Key': 'your-client-key'
      },
      body: JSON.stringify({ query })
    });

    // 檢查 HTTP 狀態
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    // 檢查 API 回應
    if (!data.success) {
      throw new Error(data.error || 'Unknown error occurred');
    }

    return data;
  } catch (error) {
    console.error('搜尋失敗:', error);
    
    // 根據錯誤類型處理
    if (error.message.includes('401')) {
      console.error('認證失敗，請檢查 client key');
    } else if (error.message.includes('500')) {
      console.error('伺服器錯誤，請稍後再試');
    }
    
    throw error;
  }
}
```

## 注意事項

1. **API Key 管理**
   - 此服務使用伺服器端的 Perplexity API key
   - 如果你有自己的 Perplexity API key，建議直接呼叫 Perplexity API（不經過此 proxy）

2. **速率限制**
   - 遵循 Perplexity API 的速率限制
   - 建議在 App 端實作請求節流（throttling）

3. **成本考量**
   - `basic` 模式使用 `sonar` 模型，較經濟
   - `advanced` 模式使用 `sonar-pro` 模型，更全面但成本較高
   - 根據使用場景選擇適當的模式

4. **安全性**
   - 永遠不要在客戶端程式碼中硬編碼 client key
   - 使用環境變數存放敏感資訊
   - 在生產環境中啟用 CORS 限制

5. **最佳實踐**
   - 為使用者提供載入狀態指示
   - 實作適當的錯誤處理和重試邏輯
   - 快取常見查詢結果以減少 API 呼叫

## 疑難排解

### 常見問題

**Q: 收到 401 錯誤**
- 檢查 `X-Client-Key` header 是否正確設定
- 確認 client key 是否有效

**Q: 收到 500 錯誤**
- 檢查伺服器端 Perplexity API key 是否已配置
- 查看 Firebase Functions 日誌以獲取詳細錯誤訊息

**Q: 回應時間過長**
- 考慮使用 `basic` 模式而非 `advanced`
- 減少 `maxTokens` 值
- 實作請求超時處理

**Q: 回應內容不夠詳細**
- 嘗試使用 `advanced` 模式
- 增加 `maxTokens` 值
- 調整 `temperature` 參數

## 支援

如有問題或需要協助，請查看：
- Firebase Functions 日誌
- Perplexity API 文件：https://docs.perplexity.ai/

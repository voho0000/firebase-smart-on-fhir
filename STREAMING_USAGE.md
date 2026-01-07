# Streaming API 使用說明

## 概述

現在兩個 Firebase Functions 都支援 streaming 模式，並使用 **Vercel AI SDK 標準 data stream 格式**：
- `proxyChatCompletion` - OpenAI API streaming
- `proxyGeminiChat` - Gemini API streaming

## 重要特性

✅ **完全相容 Vercel AI SDK** - Response 格式與直接使用 Vercel AI SDK 完全一致  
✅ **統一的客戶端程式碼** - 無論是直接用 API key 還是透過我們的服務，程式碼都一樣  
✅ **支援所有 Vercel AI SDK 工具** - 可直接使用 `useChat`, `useCompletion` 等 hooks  

## 如何啟用 Streaming

在 request payload 中加入 `"stream": true` 參數即可啟用 streaming。

## React 範例 (使用 Vercel AI SDK - 推薦)

### 使用 `useChat` Hook

這是最簡單的方式，程式碼與直接使用 OpenAI/Gemini API 完全相同：

```typescript
import { useChat } from 'ai/react';

function ChatComponent() {
  const { messages, input, handleInputChange, handleSubmit, isLoading } = useChat({
    // 只需要改變 API endpoint，其他程式碼完全不變！
    api: 'https://your-project.cloudfunctions.net/proxyChatCompletion',
    headers: {
      'x-proxy-key': 'your-client-key' // 如果有設定 client key
    },
    body: {
      stream: true,
      model: 'gpt-4'
    }
  });

  return (
    <div>
      <div className="messages">
        {messages.map(m => (
          <div key={m.id}>
            <strong>{m.role}:</strong> {m.content}
          </div>
        ))}
      </div>
      
      <form onSubmit={handleSubmit}>
        <input 
          value={input} 
          onChange={handleInputChange}
          disabled={isLoading}
          placeholder="Type your message..."
        />
        <button type="submit" disabled={isLoading}>
          Send
        </button>
      </form>
    </div>
  );
}
```

### 使用 `useCompletion` Hook

```typescript
import { useCompletion } from 'ai/react';

function CompletionComponent() {
  const { completion, input, handleInputChange, handleSubmit } = useCompletion({
    api: 'https://your-project.cloudfunctions.net/proxyChatCompletion',
    headers: {
      'x-proxy-key': 'your-client-key'
    },
    body: {
      stream: true,
      model: 'gpt-4'
    }
  });

  return (
    <div>
      <div>{completion}</div>
      <form onSubmit={handleSubmit}>
        <input value={input} onChange={handleInputChange} />
        <button type="submit">Generate</button>
      </form>
    </div>
  );
}
```

## JavaScript/TypeScript 原生範例

### 使用 Vercel AI SDK 的 `readDataStream`

```typescript
import { readDataStream } from 'ai';

const response = await fetch('https://your-project.cloudfunctions.net/proxyChatCompletion', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-proxy-key': 'your-client-key'
  },
  body: JSON.stringify({
    model: 'gpt-4',
    messages: [{ role: 'user', content: 'Hello!' }],
    stream: true
  })
});

// 使用 Vercel AI SDK 的 readDataStream 來解析 response
const stream = readDataStream(response.body);

for await (const chunk of stream) {
  console.log('Received:', chunk);
  // chunk 會是解析後的文字內容
}
```

### 手動解析 Data Stream (不使用 Vercel AI SDK)

如果你不想使用 Vercel AI SDK 的工具，也可以手動解析：

```javascript
const response = await fetch('https://your-project.cloudfunctions.net/proxyChatCompletion', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-proxy-key': 'your-client-key'
  },
  body: JSON.stringify({
    model: 'gpt-4',
    messages: [{ role: 'user', content: 'Hello!' }],
    stream: true
  })
});

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';
  
  for (const line of lines) {
    if (!line.trim()) continue;
    
    // Vercel AI SDK data stream 格式: "0:\"text\"\n" 或 "d:{...}\n"
    if (line.startsWith('0:')) {
      const text = JSON.parse(line.slice(2));
      console.log('Text chunk:', text);
    } else if (line.startsWith('d:')) {
      const data = JSON.parse(line.slice(2));
      console.log('Finish reason:', data.finishReason);
    }
  }
}
```

## Gemini Streaming 範例

Gemini 的使用方式與 OpenAI 完全相同，只需要改變 endpoint：

```typescript
import { useChat } from 'ai/react';

function GeminiChatComponent() {
  const { messages, input, handleInputChange, handleSubmit } = useChat({
    // 使用 Gemini endpoint
    api: 'https://your-project.cloudfunctions.net/proxyGeminiChat',
    headers: {
      'x-proxy-key': 'your-client-key'
    },
    body: {
      stream: true,
      model: 'gemini-2.0-flash-exp'
    }
  });

  return (
    <div>
      {messages.map(m => (
        <div key={m.id}>
          <strong>{m.role}:</strong> {m.content}
        </div>
      ))}
      <form onSubmit={handleSubmit}>
        <input value={input} onChange={handleInputChange} />
        <button type="submit">Send</button>
      </form>
    </div>
  );
}
```

## 非 Streaming 模式

如果不加 `stream: true` 或設為 `stream: false`，API 會回傳完整的 response：

```javascript
const response = await fetch('https://your-project.cloudfunctions.net/proxyChatCompletion', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-proxy-key': 'your-client-key'
  },
  body: JSON.stringify({
    model: 'gpt-4',
    messages: [
      { role: 'user', content: 'Hello!' }
    ],
    stream: false // 或不加這個參數
  })
});

const data = await response.json();
console.log(data.message); // 完整的回應文字
```

## 支援的參數

### OpenAI (proxyChatCompletion)

- `model`: 模型名稱 (例如: 'gpt-4', 'gpt-3.5-turbo')
- `messages`: 訊息陣列
- `stream`: true/false
- `temperature`: 溫度參數 (0-2)
- `max_tokens`: 最大 token 數
- `top_p`: Top-p sampling
- `frequency_penalty`: 頻率懲罰
- `presence_penalty`: 存在懲罰

### Gemini (proxyGeminiChat)

- `model`: 模型名稱 (例如: 'gemini-2.0-flash-exp')
- `messages`: 訊息陣列
- `stream`: true/false
- `temperature`: 溫度參數
- `max_output_tokens`: 最大輸出 token 數
- `top_p`: Top-p sampling
- `top_k`: Top-k sampling

## 注意事項

1. **Response Format**: Streaming 模式會回傳 `text/event-stream` 格式
2. **Error Handling**: 記得處理網路錯誤和 stream 中斷的情況
3. **API Keys**: 確保環境變數中已設定 `OPENAI_API_KEY` 和 `GEMINI_API_KEY`
4. **Client Keys**: 如果有設定 client key 驗證，記得在 header 中加入 `x-proxy-key`

## 技術實作

使用 **Vercel AI SDK** 實作 streaming：
- 統一的 API 介面
- 自動處理 streaming protocol
- 支援多種 AI providers (OpenAI, Gemini, Anthropic 等)
- 簡化錯誤處理

相關套件：
- `ai` - Vercel AI SDK 核心
- `@ai-sdk/openai` - OpenAI provider
- `@ai-sdk/google` - Google Gemini provider

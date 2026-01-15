# Vercel AI SDK 整合指南

本文件說明如何在使用 Vercel AI SDK 的 App 中整合 Perplexity 搜尋功能。

## 安裝依賴

```bash
npm install ai @ai-sdk/openai
# 或
pnpm add ai @ai-sdk/openai
```

## Tool 定義

### 方式 1：使用 `tool()` 函數（推薦）

```typescript
import { tool } from 'ai';
import { z } from 'zod';

export const searchMedicalLiteratureTool = tool({
  description: 'Search medical literature and research papers using Perplexity AI. Use this when users ask about medical conditions, treatments, clinical guidelines, or need evidence-based medical information.',
  parameters: z.object({
    query: z.string().describe('The medical question or search query'),
    searchDepth: z.enum(['basic', 'advanced']).optional().describe('Search depth: basic for quick search, advanced for comprehensive search. Default is basic.'),
  }),
  execute: async ({ query, searchDepth = 'basic' }) => {
    const response = await fetch(
      'https://us-central1-smart-on-fhir-ac97d.cloudfunctions.net/proxyPerplexitySearch',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Key': process.env.FIREBASE_CLIENT_KEY!,
        },
        body: JSON.stringify({
          query,
          searchDepth,
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to search: ${response.statusText}`);
    }

    const data = await response.json();

    if (!data.success) {
      throw new Error(data.error || 'Search failed');
    }

    return {
      content: data.content,
      citations: data.citations || [],
    };
  },
});
```

## 使用範例

### Next.js App Router API Route

```typescript
// app/api/chat/route.ts
import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';
import { searchMedicalLiteratureTool } from '@/lib/tools';

export const maxDuration = 30;

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: openai('gpt-4o'),
    messages,
    tools: {
      searchMedicalLiterature: searchMedicalLiteratureTool,
    },
    maxSteps: 5, // 允許多步驟推理
  });

  return result.toDataStreamResponse();
}
```

### React Client Component

```typescript
'use client';

import { useChat } from 'ai/react';

export default function Chat() {
  const { messages, input, handleInputChange, handleSubmit, isLoading } = useChat({
    api: '/api/chat',
  });

  return (
    <div className="flex flex-col h-screen">
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((message) => (
          <div
            key={message.id}
            className={`flex ${
              message.role === 'user' ? 'justify-end' : 'justify-start'
            }`}
          >
            <div
              className={`max-w-[80%] rounded-lg p-4 ${
                message.role === 'user'
                  ? 'bg-blue-500 text-white'
                  : 'bg-gray-200 text-gray-900'
              }`}
            >
              {message.content}
              
              {/* 顯示 tool calls */}
              {message.toolInvocations?.map((toolInvocation) => {
                if (toolInvocation.toolName === 'searchMedicalLiterature') {
                  if (toolInvocation.state === 'result') {
                    const result = toolInvocation.result as {
                      content: string;
                      citations: string[];
                    };
                    return (
                      <div key={toolInvocation.toolCallId} className="mt-2 text-sm">
                        <div className="font-semibold">📚 搜尋結果：</div>
                        <div className="mt-1">{result.content}</div>
                        {result.citations.length > 0 && (
                          <div className="mt-2">
                            <div className="font-semibold">引用來源：</div>
                            <ul className="list-disc list-inside">
                              {result.citations.map((citation, i) => (
                                <li key={i}>
                                  <a
                                    href={citation}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="underline hover:text-blue-600"
                                  >
                                    {citation}
                                  </a>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    );
                  }
                }
                return null;
              })}
            </div>
          </div>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="p-4 border-t">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={handleInputChange}
            placeholder="詢問醫療問題..."
            className="flex-1 p-2 border rounded"
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={isLoading}
            className="px-4 py-2 bg-blue-500 text-white rounded disabled:bg-gray-300"
          >
            {isLoading ? '思考中...' : '發送'}
          </button>
        </div>
      </form>
    </div>
  );
}
```

## 進階配置

### 1. 多個 Tools

```typescript
// app/api/chat/route.ts
import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';
import { searchMedicalLiteratureTool } from '@/lib/tools/perplexity';
import { getFHIRDataTool } from '@/lib/tools/fhir';

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: openai('gpt-4o'),
    messages,
    tools: {
      searchMedicalLiterature: searchMedicalLiteratureTool,
      getFHIRData: getFHIRDataTool,
    },
    maxSteps: 5,
  });

  return result.toDataStreamResponse();
}
```

### 2. 自訂 System Prompt

```typescript
export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: openai('gpt-4o'),
    system: `You are a medical AI assistant. When users ask about medical conditions, 
    treatments, or clinical guidelines, use the searchMedicalLiterature tool to find 
    evidence-based information. Always cite your sources and remind users to consult 
    healthcare professionals for medical advice.`,
    messages,
    tools: {
      searchMedicalLiterature: searchMedicalLiteratureTool,
    },
    maxSteps: 5,
  });

  return result.toDataStreamResponse();
}
```

### 3. 錯誤處理

```typescript
// lib/tools/perplexity.ts
import { tool } from 'ai';
import { z } from 'zod';

export const searchMedicalLiteratureTool = tool({
  description: 'Search medical literature and research papers.',
  parameters: z.object({
    query: z.string().describe('The medical question or search query'),
    searchDepth: z.enum(['basic', 'advanced']).optional(),
  }),
  execute: async ({ query, searchDepth = 'basic' }) => {
    try {
      const response = await fetch(
        'https://us-central1-smart-on-fhir-ac97d.cloudfunctions.net/proxyPerplexitySearch',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Client-Key': process.env.FIREBASE_CLIENT_KEY!,
          },
          body: JSON.stringify({ query, searchDepth }),
        }
      );

      if (!response.ok) {
        console.error('Perplexity API error:', response.status, response.statusText);
        return {
          content: `抱歉，搜尋服務暫時無法使用（錯誤代碼：${response.status}）。請稍後再試。`,
          citations: [],
          error: true,
        };
      }

      const data = await response.json();

      if (!data.success) {
        console.error('Search failed:', data.error);
        return {
          content: `搜尋失敗：${data.error}`,
          citations: [],
          error: true,
        };
      }

      return {
        content: data.content,
        citations: data.citations || [],
        error: false,
      };
    } catch (error) {
      console.error('Unexpected error:', error);
      return {
        content: '發生未預期的錯誤，請稍後再試。',
        citations: [],
        error: true,
      };
    }
  },
});
```

### 4. 使用 generateText（非串流）

```typescript
// app/api/search/route.ts
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { searchMedicalLiteratureTool } from '@/lib/tools';

export async function POST(req: Request) {
  const { query } = await req.json();

  const result = await generateText({
    model: openai('gpt-4o'),
    prompt: `Search for medical information about: ${query}`,
    tools: {
      searchMedicalLiterature: searchMedicalLiteratureTool,
    },
    maxSteps: 3,
  });

  return Response.json({
    text: result.text,
    toolResults: result.toolResults,
  });
}
```

## 環境變數設定

在 `.env.local` 中設定：

```bash
# OpenAI API Key
OPENAI_API_KEY=sk-...

# Firebase Client Key（用於認證）
FIREBASE_CLIENT_KEY=your-client-key
```

## 使用範例對話

**User:** "What are the latest treatment guidelines for Type 2 Diabetes?"

**Assistant:** 
1. 呼叫 `searchMedicalLiterature` tool
2. 取得 Perplexity 搜尋結果
3. 整理並回應使用者，附上引用來源

## 測試

```typescript
// test/perplexity-tool.test.ts
import { searchMedicalLiteratureTool } from '@/lib/tools';

describe('Perplexity Tool', () => {
  it('should search medical literature', async () => {
    const result = await searchMedicalLiteratureTool.execute({
      query: 'What is the treatment for hypertension?',
      searchDepth: 'basic',
    });

    expect(result.content).toBeTruthy();
    expect(result.error).toBe(false);
  });

  it('should handle errors gracefully', async () => {
    // Mock fetch to return error
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      } as Response)
    );

    const result = await searchMedicalLiteratureTool.execute({
      query: 'test query',
    });

    expect(result.error).toBe(true);
    expect(result.content).toContain('無法使用');
  });
});
```

## 注意事項

1. **環境變數安全**
   - 永遠不要在客戶端暴露 `FIREBASE_CLIENT_KEY`
   - 只在 API Route（伺服器端）中使用

2. **速率限制**
   - 考慮在 API Route 中實作速率限制
   - 使用 `maxSteps` 限制 tool 呼叫次數

3. **成本控制**
   - 預設使用 `basic` 模式（較便宜）
   - 只在需要深度搜尋時使用 `advanced`

4. **使用者體驗**
   - 顯示 loading 狀態
   - 顯示 tool 執行過程（可選）
   - 提供引用來源連結

## 參考資源

- [Vercel AI SDK 文件](https://sdk.vercel.ai/docs)
- [Tool Calling 指南](https://sdk.vercel.ai/docs/ai-sdk-core/tools-and-tool-calling)
- [Perplexity API 使用說明](./PERPLEXITY_API_USAGE.md)

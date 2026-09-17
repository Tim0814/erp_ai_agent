import { LlmExplainer, StubExplainer } from "./llm.js";

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
  error?: {
    message?: string;
  };
}

/**
 * 呼叫 Google Gemini REST API (gemini-1.5-flash) 的實作
 * 若未設定 API Key，將自動優雅降級為 StubExplainer，保證 PoC 開箱即用
 */
export class GeminiExplainer implements LlmExplainer {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fallbackStub: StubExplainer;

  constructor(options?: { apiKey?: string; model?: string }) {
    this.apiKey = options?.apiKey ?? process.env["GEMINI_API_KEY"] ?? "";
    this.model =
      options?.model ?? process.env["GEMINI_MODEL"] ?? "gemini-3.8-flash";
    this.fallbackStub = new StubExplainer();
  }

  async explain(prompt: string): Promise<string> {
    if (!this.apiKey) {
      // 自動降級為 Stub 模式
      return await this.fallbackStub.explain(prompt);
    }

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: prompt }],
            },
          ],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 1000,
          },
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.warn(
          `[GeminiExplainer] API 呼叫失敗 (${response.status})，降級使用 Stub。錯誤細節：${errText}`,
        );
        return await this.fallbackStub.explain(prompt);
      }

      const data = (await response.json()) as GeminiResponse;
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

      if (!text) {
        return await this.fallbackStub.explain(prompt);
      }

      return text;
    } catch (err) {
      console.warn("[GeminiExplainer] 網路或請求異常，降級使用 Stub:", err);
      return await this.fallbackStub.explain(prompt);
    }
  }
}

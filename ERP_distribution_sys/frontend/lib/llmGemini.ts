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
 * 最多重試次數（僅限 429 速率限制錯誤）
 * 設為 0 表示遇到 429 直接 fallback，不重試，避免等待時間拖垮 Vercel Function 逾時
 */
const MAX_RETRY = 0;

/**
 * 呼叫 Google Gemini REST API (gemini-1.5-flash) 的實作
 * 若未設定 API Key，將自動優雅降級為 StubExplainer，保證 PoC 開箱即用
 *
 * 速率限制處理：
 * - 收到 429 時，等待 RETRY_DELAY_MS 後重試，最多重試 MAX_RETRY 次
 * - 其他非 2xx 錯誤（400 格式錯誤、5xx 等）不重試，直接降級
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
      // 未設定 API Key，自動降級為 Stub 模式
      return await this.fallbackStub.explain(prompt);
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

    let attempt = 0;

    while (attempt <= MAX_RETRY) {
      try {
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
              thinkingConfig: {
                thinkingLevel: "low",
              },
            },
          }),
        });

        // ── 429 速率限制：直接 fallback（不重試，避免等待時間拖垮逾時預算）──
        if (response.status === 429) {
          console.error("[Gemini 429限流，改用備援]");
          return await this.fallbackStub.explain(prompt);
        }

        // ── 其他非 2xx 錯誤：直接降級，不重試 ─────────────────────────────
        if (!response.ok) {
          const errText = await response.text();
          console.error(
            `[Gemini 其他錯誤，改用備援]：HTTP ${response.status} — ${errText}`,
          );
          return await this.fallbackStub.explain(prompt);
        }

        // ── 成功：解析回應 ───────────────────────────────────────────────────
        const data = (await response.json()) as GeminiResponse;
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

        if (!text) {
          console.error("[Gemini 其他錯誤，改用備援]：回傳內容為空");
          return await this.fallbackStub.explain(prompt);
        }

        return text;
      } catch (err) {
        // ── 網路層例外（DNS、逾時等）：不重試，直接降級 ──────────────────
        console.error("[Gemini 其他錯誤，改用備援]：網路或請求異常 —", err);
        return await this.fallbackStub.explain(prompt);
      }
    }

    // 理論上不會走到這裡（while 條件保證 attempt > MAX_RETRY 時已在迴圈內返回）
    return await this.fallbackStub.explain(prompt);
  }
}

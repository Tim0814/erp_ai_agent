/**
 * LLM 解釋層
 *
 * 設計原則：
 * - LLM 只接收「已算好的數字結果」作為輸入
 * - LLM 不決定分配結果，只負責把已算好的結論翻譯成白話文
 * - 透過 LlmExplainer 介面隔離 provider，方便替換 OpenAI / Azure / Bedrock 等
 */

import { AllocationResult, ScoreBreakdown } from './types.js';

// ─── Provider 介面 ─────────────────────────────────────────────────────────────

/**
 * LLM Provider 介面
 * 實作此介面即可接入任意 LLM 服務（OpenAI、Azure OpenAI、AWS Bedrock 等）
 */
export interface LlmExplainer {
  /**
   * 根據分配結果產生自然語言解釋
   * @param prompt 已組裝好的 prompt 字串（由 buildPrompt 產生）
   * @returns 自然語言解釋文字
   */
  explain(prompt: string): Promise<string>;
}

// ─── Prompt 組裝 ───────────────────────────────────────────────────────────────

/**
 * 當引擎跳過分數較高但會觸發紅燈的批次、改選較低分批次時，
 * 傳入此結構讓 LLM 在生成 rationale 時能自然帶入跳過決策的背景。
 * signalReason 只描述最終選中批次自己的燈號原因，
 * 被跳過批次的資訊僅透過這個 context 物件傳遞。
 */
export interface SkippedCandidateContext {
  /** 被跳過的高分批次 ID */
  batchId: string;
  /** 被跳過批次的加權總分 */
  totalScore: number;
  /** 預判觸發紅燈的原因（來自 computeSignal 的 signal.reason） */
  redReason: string;
}

/**
 * 將規則引擎的計算結果組成 prompt
 * LLM 只看到數字與結論，不會接觸到原始批次或訂單資料
 *
 * @param result           引擎產出的分配結果
 * @param skippedCandidate 若引擎跳過了分數更高的批次，傳入此 context 讓 LLM 知情；
 *                         一般情境（未跳過）省略此參數
 */
export function buildPrompt(result: AllocationResult, skippedCandidate?: SkippedCandidateContext): string {
  if (result.status === 'blocked') {
    return (
      `你是食品供應鏈 ERP 系統的助理。請用繁體中文，以一句清楚簡短的話，` +
      `說明以下訂單無法自動分配的原因，並提示需要人工處理。\n\n` +
      `訂單編號：${result.orderId}\n` +
      `阻斷原因：${result.blockedReason}\n\n` +
      `請直接輸出說明文字，不要加任何前綴或標題。`
    );
  }

  const { scores, totalScore, orderId, recommendedBatchId, status } = result;
  const scoreLines = formatScores(scores);
  const statusLabel = status === 'partial' ? '部分分配' : '建議分配';

  // 若有被跳過的高分批次，附上結構化背景資訊供 LLM 參考
  const skippedSection = skippedCandidate
    ? (
      `\n補充背景（請自然融入說明，勿逐字照抄）：\n` +
      `  原始最高分批次：${skippedCandidate.batchId}` +
      `（總分 ${skippedCandidate.totalScore.toFixed(2)}）\n` +
      `  跳過原因：${skippedCandidate.redReason}\n` +
      `  系統因此改選上方建議批次以避免風險。\n`
    )
    : '';

  return (
    `你是食品供應鏈 ERP 系統的助理。請用繁體中文，以一句清楚簡短的話，` +
    `解釋以下訂單分配結果的主要原因（不要重複列出所有數字，` +
    `只需點出最關鍵的 1~2 個因素）。\n\n` +
    `訂單編號：${orderId}\n` +
    `分配狀態：${statusLabel}\n` +
    `建議批次：${recommendedBatchId}\n` +
    `加權總分：${totalScore.toFixed(2)}\n` +
    `各分項分數（0~100）：\n${scoreLines}\n` +
    skippedSection +
    `\n請直接輸出說明文字，不要加任何前綴或標題。`
  );
}

function formatScores(scores: ScoreBreakdown): string {
  return [
    `  - 效期分數（expiry）：${scores.expiry.toFixed(1)}`,
    `  - 交期急迫性（urgency）：${scores.urgency.toFixed(1)}`,
    `  - 下單先後（orderTime）：${scores.orderTime.toFixed(1)}`,
    `  - 客戶等級（customerTier）：${scores.customerTier.toFixed(1)}`,
    `  - 區域集群（regionCluster）：${scores.regionCluster.toFixed(1)}`,
  ].join('\n');
}

// ─── 預設實作：OpenAI ──────────────────────────────────────────────────────────

/** OpenAI API 回應的最小型別定義 */
interface OpenAiResponse {
  choices: Array<{ message: { content: string } }>;
}

/**
 * 呼叫 OpenAI Chat Completions API 的預設實作
 * 使用 fetch（Node 18+ 原生支援），無需額外安裝 openai SDK
 *
 * 環境變數：
 *   OPENAI_API_KEY  必填
 *   OPENAI_MODEL    選填，預設 "gpt-4o-mini"
 *   OPENAI_API_URL  選填，預設官方端點（可指向 Azure 或自架 proxy）
 */
export class OpenAiExplainer implements LlmExplainer {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly apiUrl: string;

  constructor(options?: { apiKey?: string; model?: string; apiUrl?: string }) {
    this.apiKey = options?.apiKey ?? process.env['OPENAI_API_KEY'] ?? '';
    this.model = options?.model ?? process.env['OPENAI_MODEL'] ?? 'gpt-4o-mini';
    this.apiUrl =
      options?.apiUrl ??
      process.env['OPENAI_API_URL'] ??
      'https://api.openai.com/v1/chat/completions';

    if (!this.apiKey) {
      throw new Error(
        'OpenAiExplainer：缺少 API Key，請設定環境變數 OPENAI_API_KEY 或在建構子傳入 apiKey',
      );
    }
  }

  async explain(prompt: string): Promise<string> {
    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 150,
        temperature: 0.3, // 降低隨機性，讓解釋更穩定
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI API 錯誤 ${response.status}：${errText}`);
    }

    const data = (await response.json()) as OpenAiResponse;
    const content = data.choices[0]?.message?.content?.trim();

    if (!content) {
      throw new Error('OpenAI API 回傳空白內容');
    }

    return content;
  }
}

// ─── 測試用 Stub ───────────────────────────────────────────────────────────────

/**
 * 不呼叫任何外部 API 的 stub 實作
 * 用於測試與開發環境，直接回傳 prompt 摘要作為假解釋
 */
export class StubExplainer implements LlmExplainer {
  async explain(prompt: string): Promise<string> {
    // 從 prompt 中擷取關鍵資訊，組成假解釋
    const orderMatch   = prompt.match(/訂單編號：(\S+)/);
    const batchMatch   = prompt.match(/建議批次：(\S+)/);
    const scoreMatch   = prompt.match(/加權總分：([\d.]+)/);
    const blockedMatch = prompt.match(/阻斷原因：(.+)/);
    const skippedMatch = prompt.match(/原始最高分批次：(\S+?)（/);

    if (blockedMatch) {
      return `[Stub] 訂單 ${orderMatch?.[1] ?? '?'} 因「${blockedMatch[1]}」無法自動分配，請人工處理。`;
    }

    const skippedNote = skippedMatch
      ? `（原高分批次 ${skippedMatch[1]} 因衝突略過）`
      : '';

    return (
      `[Stub] 訂單 ${orderMatch?.[1] ?? '?'} 建議分配批次 ` +
      `${batchMatch?.[1] ?? '?'}，加權總分 ${scoreMatch?.[1] ?? '?'}。${skippedNote}`
    );
  }
}

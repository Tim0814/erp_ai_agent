/**
 * 燈號分流判斷模組（Signal Color Classifier）
 *
 * 在分配引擎完成評分與批次選擇之後執行，
 * 對每筆 AllocationResult 標記 green / yellow / red，
 * 供下游人工複核流程與 Supabase 寫入使用。
 *
 * ────────────────────────────────────────────────────────
 * 規則優先順序（由高到低）：
 *   1. RED  條件（任一成立即為 red，不再往下判斷）
 *   2. YELLOW 條件（任一成立即為 yellow）
 *   3. 其餘 → GREEN
 * ────────────────────────────────────────────────────────
 */

import { AllocationResult, Order, SignalColor } from './types.js';

// ─── 常數：yellow 門檻 ─────────────────────────────────────────────────────────

/**
 * 加權總分低於此值視為「低信心」→ yellow
 *
 * 理由：評分系統滿分 100，80 分以上為高信心自動建議，
 * 60 分以下已屬於批次條件與訂單需求匹配度偏低的區間，
 * 介於 60~79 分時各項評分均未達明顯優勢，人工確認可避免誤判。
 */
const YELLOW_SCORE_THRESHOLD = 60;

/**
 * 效期距今天數低於此值視為「即將過期」→ yellow
 *
 * 理由：食品業慣例以 3 天做為最後出貨警戒線。
 * 批次雖未過期（已通過 hardConstraints），但距效期 ≤ 3 天時
 * 若配送延誤仍可能造成客訴，需人工確認是否接受此批次。
 */
const YELLOW_EXPIRY_DAYS = 3;

/**
 * 距客戶要求交期的天數低於此值視為「交期極度緊迫」→ yellow
 *
 * 理由：距交期 ≤ 1 天的訂單若因任何原因延誤出貨，
 * 後果嚴重（違約、扣款）。雖然 urgency 分數已反映急迫性，
 * 但自動分配在最後 1 天仍應觸發人工確認，降低風險。
 */
const YELLOW_DUE_DAYS = 1;

/**
 * 分配數量佔批次原始可用量的比例超過此值 → yellow
 *
 * 理由：單筆訂單吃掉批次 ≥ 90% 的量，會讓其他訂單無批次可用，
 * 屬於「高衝擊分配」，建議人工確認是否保留緩衝。
 */
const YELLOW_BATCH_CONSUMPTION_RATIO = 0.9;

// ─── 輸入型別 ──────────────────────────────────────────────────────────────────

export interface SignalInput {
  /** 引擎產出的分配結果（尚未寫入 signalColor） */
  result: AllocationResult;
  /** 對應此筆訂單的原始訂單資料 */
  order: Order;
  /**
   * 分配前的批次原始可用量快照（key = batchId）
   * 用於計算「分配量佔原始庫存比例」的 yellow 檢查。
   * 若無法提供，傳入空 Map，相關 yellow 規則會自動跳過。
   */
  originalBatchQty: Map<string, number>;
  /** 基準日期，預設 new Date()；測試時可注入固定日期 */
  today?: Date;
  /**
   * 已存在的未取消分配批次 ID 集合（來自 DB 查詢）
   * 用於「重複分配」red 檢查。
   * 若無法提供，傳入空 Set，此 red 規則會自動跳過。
   */
  existingAllocatedBatchIds?: Set<string>;
}

export interface SignalOutput {
  signalColor: SignalColor;
  signalReason: string;
}

// ─── 主判斷函式 ────────────────────────────────────────────────────────────────

/**
 * 對單筆分配結果進行燈號分流
 *
 * @param input 燈號判斷所需的所有上下文
 * @returns     { signalColor, signalReason }
 */
export function classifySignal(input: SignalInput): SignalOutput {
  const { result, order, originalBatchQty, existingAllocatedBatchIds = new Set() } = input;
  const today = input.today ?? new Date();
  const msPerDay = 86_400_000;

  // ── RED 判斷 ──────────────────────────────────────────────────────────────────

  // RED-1：分配數量超過現有可用庫存
  // 正常流程下硬規則已攔截，但若引擎以 partial 狀態輸出（availableQty 被多筆訂單
  // 競搶導致負值），或呼叫方傳入異常資料，這裡作最後保護。
  if (result.status === 'partial') {
    return {
      signalColor: 'red',
      signalReason:
        'RED-1：分配數量超過批次可用庫存（partial 狀態，批次剩餘量不足以完整供應此訂單）',
    };
  }

  // RED-2：建議交貨日期（即分配當下的今天）已超過客戶要求交期
  // 引擎以 today 作為「出貨基準日」；若今天已超過 requestedDate，代表無論如何
  // 都已違約，此筆建議需人工決定是否仍要出貨或改期。
  const daysUntilDue = (order.requestedDate.getTime() - today.getTime()) / msPerDay;
  if (daysUntilDue < 0) {
    return {
      signalColor: 'red',
      signalReason: `RED-2：建議交貨日（${today.toISOString().slice(0, 10)}）已超過客戶要求交期（${order.requestedDate.toISOString().slice(0, 10)}），逾期 ${Math.abs(Math.floor(daysUntilDue))} 天`,
    };
  }

  // RED-3：同一個 production_batch 已存在未取消的分配紀錄（重複分配）
  if (
    result.recommendedBatchId !== null &&
    existingAllocatedBatchIds.has(result.recommendedBatchId)
  ) {
    return {
      signalColor: 'red',
      signalReason: `RED-3：批次 ${result.recommendedBatchId} 已存在未取消的分配紀錄，重複分配風險`,
    };
  }

  // blocked 狀態本身不屬於上述三個 red 條件，但無法自動放行，直接給 red
  if (result.status === 'blocked') {
    return {
      signalColor: 'red',
      signalReason: `RED-4：訂單被硬性規則阻斷，無可用批次（${result.blockedReason ?? '原因未知'}）`,
    };
  }

  // ── YELLOW 判斷 ───────────────────────────────────────────────────────────────

  const yellowReasons: string[] = [];

  // YELLOW-1：加權總分低於門檻（低信心分配）
  if (result.totalScore < YELLOW_SCORE_THRESHOLD) {
    yellowReasons.push(
      `YELLOW-1：加權總分 ${result.totalScore.toFixed(1)} 低於門檻 ${YELLOW_SCORE_THRESHOLD}（批次與訂單匹配度偏低）`,
    );
  }

  // YELLOW-2：批次效期距今 ≤ 3 天（即將過期）
  if (result.recommendedBatchId !== null) {
    // 注意：效期資訊需從外部批次清單取得；此處透過 scores.expiry 反推。
    // expiry score = max(0, 100 - daysUntilExpiry * (100/30))
    // daysUntilExpiry = (100 - expiryScore) / (100/30) = (100 - expiryScore) * 30 / 100
    const estimatedDaysUntilExpiry = (100 - result.scores.expiry) * 30 / 100;
    if (estimatedDaysUntilExpiry <= YELLOW_EXPIRY_DAYS) {
      yellowReasons.push(
        `YELLOW-2：批次推估效期距今約 ${estimatedDaysUntilExpiry.toFixed(1)} 天（≤ ${YELLOW_EXPIRY_DAYS} 天），即將過期`,
      );
    }
  }

  // YELLOW-3：距客戶要求交期 ≤ 1 天（交期極度緊迫）
  if (daysUntilDue <= YELLOW_DUE_DAYS) {
    yellowReasons.push(
      `YELLOW-3：距客戶要求交期僅剩 ${daysUntilDue.toFixed(1)} 天（≤ ${YELLOW_DUE_DAYS} 天），出貨時間極度緊迫`,
    );
  }

  // YELLOW-4：此筆分配消耗批次 ≥ 90% 的原始可用量（高衝擊分配）
  if (result.recommendedBatchId !== null) {
    const originalQty = originalBatchQty.get(result.recommendedBatchId);
    if (originalQty !== undefined && originalQty > 0) {
      const consumptionRatio = order.requestedQty / originalQty;
      if (consumptionRatio >= YELLOW_BATCH_CONSUMPTION_RATIO) {
        yellowReasons.push(
          `YELLOW-4：本次分配量（${order.requestedQty}）佔批次原始可用量（${originalQty}）的 ${(consumptionRatio * 100).toFixed(1)}%（≥ ${YELLOW_BATCH_CONSUMPTION_RATIO * 100}%），高衝擊分配`,
        );
      }
    }
  }

  if (yellowReasons.length > 0) {
    return {
      signalColor: 'yellow',
      signalReason: yellowReasons.join('；'),
    };
  }

  // ── GREEN ─────────────────────────────────────────────────────────────────────
  return {
    signalColor: 'green',
    signalReason: `GREEN：加權總分 ${result.totalScore.toFixed(1)}，無風險因子，可自動放行`,
  };
}

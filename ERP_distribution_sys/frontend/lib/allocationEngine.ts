/**
 * 分配引擎主體（AllocationEngine）
 *
 * 流程：
 * 1. 驗證權重設定
 * 2. 依訂單總分排序（讓高分訂單優先搶批次）
 * 3. 對每筆訂單：
 *    a. 硬性規則過濾
 *    b. 加權評分 & 排序候選批次
 *    c. 選出最高分批次，即時扣減 availableQty（防超賣）
 *    d. 燈號分流（green / yellow / red）
 *    e. 組裝輸出，呼叫 LLM 解釋層
 */

import { AllocationInput, AllocationResult, Batch, BatchScore, ScoreBreakdown, SignalColor } from './types.js';
import { validateWeights } from './weights.js';
import { applyHardConstraints } from './hardConstraints.js';
import { rankBatches } from './scoring.js';
import { LlmExplainer, buildPrompt, StubExplainer, SkippedCandidateContext } from './llm.js';
import { GeminiExplainer } from './llmGemini.js';

// ─── 引擎選項 ──────────────────────────────────────────────────────────────────

export interface AllocationEngineOptions {
  /** LLM 解釋器實作，預設使用 StubExplainer（不呼叫真實 API） */
  explainer?: LlmExplainer;
  /** 基準日期，預設 new Date()；測試時可注入固定日期 */
  today?: Date;
  /**
   * 從 DB 查回的「已存在未取消分配」batchId 集合。
   * 引擎用此判斷跨執行期的重複分配（red 條件之一）。
   * 預設空集合（離線 / 測試情境）。
   */
  existingAllocatedBatchIds?: Set<string>;
}

// ─── 燈號判斷常數 ──────────────────────────────────────────────────────────────

/**
 * 加權總分低於此值 → yellow（低信心度，需人工複核）
 * 理由：評分系統滿分 100，60 分以下代表沒有任何一個維度特別突出，
 * 選出的批次與其他候選批次差距可能不大，應由人工確認。
 */
const YELLOW_SCORE_THRESHOLD = 60;

/**
 * 批次效期距今天數低於此值 → yellow（食品安全邊際薄）
 * 理由：7 天內到期的批次若出貨延誤即可能造成食安問題，
 * 需人工確認物流時程可在期限內送達。
 */
const YELLOW_EXPIRY_DAYS = 7;

/**
 * 批次送達客戶後剩餘有效期天數低於此值 → yellow（送達即將過期）
 * 理由：即使在效期內出貨，若抵達客戶手上時剩餘有效期 < 3 天，
 * 客戶可能拒收或造成退貨，需事先溝通確認。
 */
const YELLOW_SHELF_LIFE_ON_ARRIVAL_DAYS = 3;

/**
 * 訂單要求交期距今天數低於此值 → yellow（緊急訂單）
 * 理由：2 天內到期的要求交期代表供應鏈時間極為緊迫，
 * 需人工確認倉儲出貨與物流能否即時配合。
 */
const YELLOW_DUE_DAYS = 2;

/**
 * 批次分配後剩餘庫存量低於此值（相對於本次分配數量的倍數）→ yellow（庫存見底警示）
 * 理由：分配後剩餘量 < 1 倍本次需求，代表下一筆相同需求的訂單很可能無法被滿足，
 * 需人工評估是否需要提前補貨或重新調配。
 */
const YELLOW_REMAINING_QTY_RATIO = 1;

// ─── 燈號判斷函式 ──────────────────────────────────────────────────────────────

interface SignalResult {
  color: SignalColor;
  reason: string;
}

/**
 * 為已被 blocked 的結果標記燈號（永遠是 red）
 */
function signalForBlocked(blockedReason: string): SignalResult {
  return { color: 'red', reason: `分配被阻斷：${blockedReason}` };
}

/**
 * 為成功分配的結果計算燈號
 *
 * 判斷優先序：red → yellow → green
 * 只要觸發任一 red 條件即標記 red（不繼續評估 yellow）。
 * 多個 yellow 條件可同時觸發，原因說明會全部列出。
 *
 * @param order            原始訂單
 * @param chosenBatch      被選中的批次（已扣減後的工作副本）
 * @param originalAvailableQty 扣減前的批次可用數量（用於判斷剩餘量）
 * @param totalScore       加權總分
 * @param today            基準日期
 * @param existingAllocatedBatchIds DB 中已存在的未取消分配 batchId 集合
 * @param allocatedThisRun 本次引擎執行中已分配過的 batchId 集合（跨訂單去重）
 */
function computeSignal(
  order: { requestedQty: number; requestedDate: Date },
  chosenBatch: Batch,
  originalAvailableQty: number,
  totalScore: number,
  today: Date,
  existingAllocatedBatchIds: Set<string>,
  allocatedThisRun: Set<string>,
): SignalResult {
  const MS_PER_DAY = 86_400_000;

  // ── Red 條件 ──────────────────────────────────────────────────────────────

  // Red-1：分配數量超過批次可用庫存（防禦性判斷，正常已被 hardConstraints 擋住）
  if (originalAvailableQty < order.requestedQty) {
    return {
      color: 'red',
      reason: `分配數量（${order.requestedQty}）超過批次可用庫存（${originalAvailableQty}）`,
    };
  }

  // Red-2：批次效期早於客戶要求交期（出貨前就已過期）
  const expiryMs = chosenBatch.expiryDate.getTime();
  const requestedDateMs = order.requestedDate.getTime();
  if (expiryMs < requestedDateMs) {
    const expiryStr = chosenBatch.expiryDate.toISOString().slice(0, 10);
    const reqStr = new Date(requestedDateMs).toISOString().slice(0, 10);
    return {
      color: 'red',
      reason: `批次效期（${expiryStr}）早於客戶要求交期（${reqStr}），出貨時已過期`,
    };
  }

  // Red-3：同一 batchId 在 DB 已存在未取消的分配（跨執行期重複分配）
  if (existingAllocatedBatchIds.has(chosenBatch.batchId)) {
    return {
      color: 'red',
      reason: `批次 ${chosenBatch.batchId} 在資料庫中已存在未取消的分配紀錄（重複分配）`,
    };
  }

  // Red-4：同一 batchId 在本次引擎執行中已被分配給另一筆訂單（批次內重複分配）
  if (allocatedThisRun.has(chosenBatch.batchId)) {
    return {
      color: 'red',
      reason: `批次 ${chosenBatch.batchId} 在本次分配執行中已被分配給其他訂單（重複分配）`,
    };
  }

  // ── Yellow 條件 ───────────────────────────────────────────────────────────

  const yellowReasons: string[] = [];

  // Yellow-1：加權總分低於門檻（低信心度）
  if (totalScore < YELLOW_SCORE_THRESHOLD) {
    yellowReasons.push(
      `加權總分（${totalScore.toFixed(1)}）低於門檻（${YELLOW_SCORE_THRESHOLD}），建議人工確認選批合理性`,
    );
  }

  // Yellow-2：批次效期距今 ≤ 7 天（食品安全邊際薄）
  const daysUntilExpiry = (expiryMs - today.getTime()) / MS_PER_DAY;
  if (daysUntilExpiry <= YELLOW_EXPIRY_DAYS) {
    yellowReasons.push(
      `批次效期距今僅 ${daysUntilExpiry.toFixed(1)} 天（≤${YELLOW_EXPIRY_DAYS} 天），物流時程需確認`,
    );
  }

  // Yellow-3：批次效期 − 要求交期 < 3 天（送達後剩餘有效期過短）
  const shelfLifeOnArrival = (expiryMs - requestedDateMs) / MS_PER_DAY;
  if (shelfLifeOnArrival >= 0 && shelfLifeOnArrival < YELLOW_SHELF_LIFE_ON_ARRIVAL_DAYS) {
    yellowReasons.push(
      `送達客戶後剩餘有效期僅 ${shelfLifeOnArrival.toFixed(1)} 天（<${YELLOW_SHELF_LIFE_ON_ARRIVAL_DAYS} 天），客戶可能拒收`,
    );
  }

  // Yellow-4：訂單要求交期距今 ≤ 2 天（緊急訂單）
  const daysUntilDue = (requestedDateMs - today.getTime()) / MS_PER_DAY;
  if (daysUntilDue <= YELLOW_DUE_DAYS) {
    yellowReasons.push(
      `訂單要求交期距今僅 ${daysUntilDue.toFixed(1)} 天（≤${YELLOW_DUE_DAYS} 天），需確認能否及時出貨`,
    );
  }

  // Yellow-5：批次扣減後剩餘量 < 1 倍本次分配數量（庫存見底警示）
  const remainingQty = originalAvailableQty - order.requestedQty;
  if (remainingQty < order.requestedQty * YELLOW_REMAINING_QTY_RATIO) {
    yellowReasons.push(
      `批次分配後剩餘庫存（${remainingQty}）不足本次需求量（${order.requestedQty}）的 ${YELLOW_REMAINING_QTY_RATIO} 倍，下一筆訂單可能無貨`,
    );
  }

  if (yellowReasons.length > 0) {
    return { color: 'yellow', reason: yellowReasons.join('；') };
  }

  // ── Green ─────────────────────────────────────────────────────────────────
  return { color: 'green', reason: '所有條件均正常，建議自動放行' };
}

// ─── 主引擎函式 ────────────────────────────────────────────────────────────────

/**
 * 執行完整的訂單分配流程
 *
 * @param input   訂單、客戶、批次與權重設定
 * @param options 可選設定（LLM 解釋器、基準日期、DB 中已存在分配的 batchId 集合）
 * @returns 每筆訂單的分配結果（順序與 input.orders 一致）
 *
 * @throws {Error} 權重設定不合法時
 * @throws {Error} 訂單中的 customerId 找不到對應客戶資料時
 */
export async function runAllocation(
  input: AllocationInput,
  options: AllocationEngineOptions = {},
): Promise<AllocationResult[]> {
  const { orders, customers, batches, weights } = input;
  const today = options.today ?? new Date();
  const explainer = options.explainer ?? new GeminiExplainer();
  const existingAllocatedBatchIds = options.existingAllocatedBatchIds ?? new Set<string>();

  // 步驟 1：驗證權重（不合法直接拋錯，不進行後續計算）
  validateWeights(weights);

  // 步驟 2：建立批次的即時庫存快照（shallow copy，避免修改原始輸入）
  //         之後的扣減只對這份 workingBatches 進行
  const workingBatches: Batch[] = batches.map((b) => ({ ...b }));

  // 步驟 3：收集所有訂單的客戶區域，提供給 regionCluster 評分使用
  const pendingOrderRegions = new Set<string>(
    orders.flatMap((order) => {
      const customer = customers.get(order.customerId);
      return customer ? [customer.region] : [];
    }),
  );

  // 步驟 4：依訂單優先權預排序（高 tierScore 客戶的訂單先搶批次）
  //         此排序只決定「搶批次的順序」，不影響最終 AllocationResult 的輸出順序
  const orderedByPriority = [...orders].sort((a, b) => {
    const tierA = customers.get(a.customerId)?.tierScore ?? 0;
    const tierB = customers.get(b.customerId)?.tierScore ?? 0;
    if (tierB !== tierA) return tierB - tierA; // 等級高的先搶
    return a.createdAt.getTime() - b.createdAt.getTime(); // 同等級：先下單先搶
  });

  // 步驟 5：逐筆處理訂單，收集結果（key = orderId）
  const resultMap = new Map<string, AllocationResult>();
  // 追蹤本次執行中已分配的 batchId（用於 Red-4 跨訂單重複分配檢查）
  const allocatedThisRun = new Set<string>();

  const totalOrders = orderedByPriority.length;
  let processedCount = 0;

  /** 每次 LLM 呼叫之間的間隔（毫秒），降低觸發 Gemini 速率限制的機率 */
  const INTER_REQUEST_DELAY_MS = 2_500;

  /** Promise-based sleep，供呼叫間延遲使用 */
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  for (const order of orderedByPriority) {
    const customer = customers.get(order.customerId);
    if (!customer) {
      throw new Error(
        `分配引擎：找不到訂單 ${order.orderId} 對應的客戶資料（customerId: ${order.customerId}）`,
      );
    }

    // 5a. 硬性規則過濾
    const filterResult = applyHardConstraints(order, workingBatches, today);

    if (!filterResult.passed) {
      // 被阻斷：燈號一律為 red，原因同時寫入 blockedReason 與 signalReason
      const signal = signalForBlocked(filterResult.reason);
      const blockedResult: AllocationResult = {
        orderId: order.orderId,
        status: 'blocked',
        recommendedBatchId: null,
        scores: zeroScores(),
        totalScore: 0,
        explanation: '',
        blockedReason: filterResult.reason,
        signalColor: signal.color,
        signalReason: signal.reason, // 對應 DB traffic_light_reason 欄位
      };
      processedCount++;
      console.log(`[分配引擎] 處理中 ${processedCount}/${totalOrders}（訂單 ${order.orderId}）`);
      blockedResult.explanation = await explainer.explain(buildPrompt(blockedResult));
      resultMap.set(order.orderId, blockedResult);
      if (processedCount < totalOrders) await sleep(INTER_REQUEST_DELAY_MS);
      continue;
    }

    // 5b. 加權評分 & 排序候選批次
    const ranked: BatchScore[] = rankBatches(
      filterResult.candidates,
      order,
      customer,
      weights,
      today,
      pendingOrderRegions,
    );

    // 5c. 優先選出第一個不會觸發紅燈的候選批次；
    //     若所有候選均會觸發紅燈則 fallback 回最高分（ranked[0]）
    const { picked, skippedCandidate } = pickBestNonRed(
      ranked,
      workingBatches,
      order,
      today,
      existingAllocatedBatchIds,
      allocatedThisRun,
    );
    const best = picked;
    const chosenBatch = workingBatches.find((b) => b.batchId === best.batchId)!;
    const originalAvailableQty = chosenBatch.availableQty; // 扣減前保留，供燈號判斷使用

    // 5d. 燈號分流（在庫存扣減之前執行，確保 Red-3/Red-4 可以中止扣減）
    const signal = computeSignal(
      order,
      chosenBatch,
      originalAvailableQty,
      best.totalScore,
      today,
      existingAllocatedBatchIds,
      allocatedThisRun,
    );

    // Red-3/Red-4：重複分配——status 改為 blocked，不扣減庫存
    // blockedReason 與 signalReason 均寫入相同原因，對應 DB blocked_reason / traffic_light_reason
    if (signal.color === 'red' && (
      existingAllocatedBatchIds.has(chosenBatch.batchId) ||
      allocatedThisRun.has(chosenBatch.batchId)
    )) {
      const dupResult: AllocationResult = {
        orderId: order.orderId,
        status: 'blocked',
        recommendedBatchId: null,
        scores: best.scores,
        totalScore: best.totalScore,
        explanation: '',
        blockedReason: signal.reason,
        signalColor: 'red',
        signalReason: signal.reason, // 對應 DB traffic_light_reason 欄位
      };
      processedCount++;
      console.log(`[分配引擎] 處理中 ${processedCount}/${totalOrders}（訂單 ${order.orderId}）`);
      dupResult.explanation = await explainer.explain(buildPrompt(dupResult));
      resultMap.set(order.orderId, dupResult);
      if (processedCount < totalOrders) await sleep(INTER_REQUEST_DELAY_MS);
      continue; // 不扣減庫存，不加入 allocatedThisRun
    }

    // 正常路徑：即時扣減庫存（防超賣）
    chosenBatch.availableQty -= order.requestedQty;

    // 判斷是 recommended 還是 partial
    // partial 的情境：批次扣減後剩餘量已見底，其他訂單可能被降級
    // 這裡的 partial 語意：此訂單被滿足了，但批次已無法再供應其他訂單
    // （若需要支援「一筆訂單只被部分滿足」的語意，可在此擴充）
    const status = chosenBatch.availableQty < 0
      ? 'partial'   // 不應發生（硬規則已擋），保守起見保留
      : 'recommended';

    // 分配成功，將此 batchId 加入本次已分配集合（Red-4 防呆用）
    allocatedThisRun.add(chosenBatch.batchId);

    const result: AllocationResult = {
      orderId: order.orderId,
      status,
      recommendedBatchId: best.batchId,
      scores: best.scores,
      totalScore: best.totalScore,
      explanation: '',
      // red 情境（非重複分配類）的原因同時放 blockedReason 與 signalReason；
      // yellow/green 時 blockedReason 為 null，signalReason 填入判斷理由
      blockedReason: signal.color === 'red' ? signal.reason : null,
      signalColor: signal.color,
      signalReason: signal.reason, // 對應 DB traffic_light_reason 欄位
    };
    // 若有被跳過的高分批次，將其 context 傳入 buildPrompt 供 LLM 自然帶入說明
    processedCount++;
    console.log(`[分配引擎] 處理中 ${processedCount}/${totalOrders}（訂單 ${order.orderId}）`);
    result.explanation = await explainer.explain(buildPrompt(result, skippedCandidate ?? undefined));
    resultMap.set(order.orderId, result);
    if (processedCount < totalOrders) await sleep(INTER_REQUEST_DELAY_MS);
  }

  // 步驟 6：依原始 orders 順序輸出（保證輸出順序與輸入一致）
  return orders.map((order) => resultMap.get(order.orderId)!);
}

// ─── 輔助函式 ──────────────────────────────────────────────────────────────────

function zeroScores(): ScoreBreakdown {
  return {
    expiry: 0,
    urgency: 0,
    orderTime: 0,
    customerTier: 0,
    regionCluster: 0,
  };
}

// ─── 選批輔助：優先跳過會觸發紅燈的候選 ──────────────────────────────────────

/**
 * 從已排序的候選清單（高分 → 低分）中，選出第一個預判不會觸發紅燈的批次。
 *
 * 預判邏輯：對每個候選呼叫 computeSignal()（不扣減庫存）。
 * - 若找到 signal.color !== 'red' 的候選 → 以該批次為 picked；
 *   若它不是 ranked[0]，則記錄 ranked[0] 為 skippedCandidate 供 LLM context 使用。
 * - 若所有候選預判均為 red → fallback 回 ranked[0]（原本行為），skippedCandidate 為 null。
 *
 * @param ranked                  已依加權分數由高到低排序的候選批次
 * @param workingBatches          即時庫存工作副本（唯讀，此函式不修改）
 * @param order                   當前訂單（用於 computeSignal 的條件判斷）
 * @param today                   基準日期
 * @param existingAllocatedBatchIds DB 中已存在未取消分配的 batchId 集合（Red-3）
 * @param allocatedThisRun        本次執行已分配的 batchId 集合（Red-4）
 */
function pickBestNonRed(
  ranked: BatchScore[],
  workingBatches: Batch[],
  order: { requestedQty: number; requestedDate: Date },
  today: Date,
  existingAllocatedBatchIds: Set<string>,
  allocatedThisRun: Set<string>,
): { picked: BatchScore; skippedCandidate: SkippedCandidateContext | null } {
  const highestRanked = ranked[0]!;

  for (const candidate of ranked) {
    const batch = workingBatches.find((b) => b.batchId === candidate.batchId)!;
    const originalQty = batch.availableQty; // 預判不扣減，直接讀現值

    const signal = computeSignal(
      order,
      batch,
      originalQty,
      candidate.totalScore,
      today,
      existingAllocatedBatchIds,
      allocatedThisRun,
    );

    if (signal.color !== 'red') {
      // 找到可用的非紅燈批次
      const wasSkipped = candidate.batchId !== highestRanked.batchId;
      return {
        picked: candidate,
        skippedCandidate: wasSkipped
          ? {
              batchId: highestRanked.batchId,
              totalScore: highestRanked.totalScore,
              // 記錄最高分批次被跳過的原因（重新對它做一次預判取得原因）
              redReason: (() => {
                const topBatch = workingBatches.find((b) => b.batchId === highestRanked.batchId)!;
                const topSignal = computeSignal(
                  order,
                  topBatch,
                  topBatch.availableQty,
                  highestRanked.totalScore,
                  today,
                  existingAllocatedBatchIds,
                  allocatedThisRun,
                );
                return topSignal.reason;
              })(),
            }
          : null,
      };
    }
  }

  // 所有候選均為紅燈 → fallback：選分數最高的，維持原本行為
  return { picked: highestRanked, skippedCandidate: null };
}

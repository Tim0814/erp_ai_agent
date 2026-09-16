/**
 * 硬性規則過濾器（Hard Constraints）
 *
 * 在進入評分之前執行，以下情況直接淘汰候選批次：
 * 1. batch.productId !== order.itemCode（商品不符，最優先過濾）
 * 2. batch.expiryDate < today（已過期）
 * 3. batch.availableQty < order.requestedQty（庫存不足／超賣防護）
 *
 * 這些規則與評分邏輯完全分離，不影響分數計算。
 */

import { Batch, Order } from './types.js';

// ─── 過濾結果型別 ──────────────────────────────────────────────────────────────

export type FilterPassResult = {
  passed: true;
  candidates: Batch[];
};

export type FilterBlockResult = {
  passed: false;
  /** 人工可讀的阻斷原因，直接放入 AllocationResult.blockedReason */
  reason: string;
};

export type FilterResult = FilterPassResult | FilterBlockResult;

// ─── 主函式 ────────────────────────────────────────────────────────────────────

/**
 * 針對單筆訂單，從所有批次中篩出符合硬性規則的候選批次
 *
 * @param order   要評估的訂單
 * @param batches 所有可用批次（availableQty 應已反映即時庫存）
 * @param today   基準日期（預設 new Date()；測試時可注入固定日期）
 * @returns FilterPassResult（有候選）或 FilterBlockResult（需人工處理）
 */
export function applyHardConstraints(
  order: Order,
  batches: Batch[],
  today: Date = new Date(),
): FilterResult {
  const todayStart = startOfDay(today);

  const wrongProduct: Batch[] = [];
  const expired: Batch[] = [];
  const insufficient: Batch[] = [];
  const candidates: Batch[] = [];

  for (const batch of batches) {
    // 規則 1：商品比對（productId 不符 → 直接淘汰，放最前面效能最好）
    if (batch.productId !== order.itemCode) {
      wrongProduct.push(batch);
      continue;
    }

    // 規則 2：效期檢查（expiryDate < today → 已過期）
    if (startOfDay(batch.expiryDate) < todayStart) {
      expired.push(batch);
      continue;
    }

    // 規則 3：庫存量檢查（availableQty 已即時扣減）
    if (batch.availableQty < order.requestedQty) {
      insufficient.push(batch);
      continue;
    }

    candidates.push(batch);
  }

  if (candidates.length > 0) {
    return { passed: true, candidates };
  }

  // 沒有任何候選批次，組成具體的阻斷原因
  const reason = buildBlockedReason(batches, expired, insufficient, wrongProduct);
  return { passed: false, reason };
}

// ─── 輔助函式 ──────────────────────────────────────────────────────────────────

/** 將 Date 截斷到當天 00:00:00（移除時間部分，只比較日期） */
function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * 根據過濾統計組成人類可讀的阻斷原因
 * 盡量給出具體資訊，方便業務人員處理
 */
function buildBlockedReason(
  all: Batch[],
  expired: Batch[],
  insufficient: Batch[],
  wrongProduct: Batch[] = [],
): string {
  if (all.length === 0) {
    return '目前無任何可用批次';
  }

  const parts: string[] = [];

  if (wrongProduct.length > 0) {
    parts.push(
      `${wrongProduct.length} 個批次商品不符（${wrongProduct.map((b) => b.batchId).join(', ')}）`,
    );
  }

  if (expired.length > 0) {
    parts.push(
      `${expired.length} 個批次已過期（${expired.map((b) => b.batchId).join(', ')}）`,
    );
  }

  if (insufficient.length > 0) {
    const detail = insufficient
      .map((b) => `${b.batchId}（剩餘 ${b.availableQty}）`)
      .join(', ');
    parts.push(`${insufficient.length} 個批次庫存不足（${detail}）`);
  }

  return parts.join('；');
}

/**
 * CompanyWeights 驗證與預設值
 *
 * 權重必須由外部設定（設定檔 / DB）載入，此模組只提供：
 * 1. 食品業合理預設值
 * 2. 總和驗證函式
 * 3. 從 JSON 物件載入並驗證的工廠函式
 */

import { CompanyWeights } from './types.js';

// ─── 容許的浮點誤差 ────────────────────────────────────────────────────────────
const WEIGHT_SUM_TOLERANCE = 0.001;

// ─── 食品業預設權重 ────────────────────────────────────────────────────────────
/**
 * 預設值設計原則：
 * - 食品業最重視 FEFO（先過期先出），expiry 給最高權重 0.35
 * - 交期急迫性次之 0.25（客戶滿意度）
 * - 客戶等級 0.20（維護重要客戶關係）
 * - 下單時間 0.12（先進先出的公平性）
 * - 區域集群 0.08（降低物流成本，但不是主要考量）
 */
export const DEFAULT_WEIGHTS: Readonly<CompanyWeights> = Object.freeze({
  expiry: 0.35,
  urgency: 0.25,
  orderTime: 0.12,
  customerTier: 0.20,
  regionCluster: 0.08,
});

/**
 * 將 DB 權重依啟用旗標過濾後，按原始比例正規化為總和 1。
 */
export function normalizeEnabledWeights(raw: unknown): CompanyWeights {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('公司權重設定不存在或格式無效，無法執行分配計算');
  }

  const row = raw as Record<string, unknown>;
  const entries: Array<[keyof CompanyWeights, string, string]> = [
    ['expiry', 'fefo_weight', 'fefo_enabled'],
    ['urgency', 'urgency_weight', 'urgency_enabled'],
    ['orderTime', 'order_time_weight', 'order_time_enabled'],
    ['customerTier', 'customer_tier_weight', 'customer_tier_enabled'],
    ['regionCluster', 'region_weight', 'region_enabled'],
  ];

  const enabledWeights = entries
    .filter(([, , enabledKey]) => row[enabledKey] === true)
    .map(([key, weightKey]) => [key, Number(row[weightKey])] as const);

  if (enabledWeights.length === 0) {
    throw new Error('公司權重設定中沒有啟用任何評分項目，無法執行分配計算');
  }

  const total = enabledWeights.reduce((sum, [, value]) => sum + value, 0);
  if (!Number.isFinite(total) || total <= 0 || enabledWeights.some(([, value]) => !Number.isFinite(value) || value < 0)) {
    throw new Error('公司權重設定包含無效數值，無法執行分配計算');
  }

  const normalized: CompanyWeights = {
    expiry: 0,
    urgency: 0,
    orderTime: 0,
    customerTier: 0,
    regionCluster: 0,
  };
  for (const [key, value] of enabledWeights) normalized[key] = value / total;
  return normalized;
}

// ─── 驗證函式 ──────────────────────────────────────────────────────────────────

/**
 * 驗證 CompanyWeights 是否合法
 *
 * 規則：
 * 1. 所有欄位必須存在且為數字
 * 2. 每個欄位必須在 [0, 1] 範圍內
 * 3. 五個欄位總和必須等於 1（容許 ±0.001 浮點誤差）
 *
 * @throws {Error} 驗證失敗時拋出帶有明確說明的錯誤
 */
export function validateWeights(weights: CompanyWeights): void {
  const keys: (keyof CompanyWeights)[] = [
    'expiry',
    'urgency',
    'orderTime',
    'customerTier',
    'regionCluster',
  ];

  // 逐欄檢查型別與範圍
  for (const key of keys) {
    const val = weights[key];
    if (typeof val !== 'number' || isNaN(val)) {
      throw new Error(`CompanyWeights.${key} 必須為數字，收到：${val}`);
    }
    if (val < 0 || val > 1) {
      throw new Error(
        `CompanyWeights.${key} 必須在 [0, 1] 範圍內，收到：${val}`,
      );
    }
  }

  // 總和驗證
  const sum = keys.reduce((acc, key) => acc + weights[key], 0);
  if (Math.abs(sum - 1) > WEIGHT_SUM_TOLERANCE) {
    throw new Error(
      `CompanyWeights 五個欄位總和必須等於 1（容許誤差 ±${WEIGHT_SUM_TOLERANCE}），` +
        `實際總和為 ${sum.toFixed(6)}`,
    );
  }
}

/**
 * 從原始物件（設定檔 JSON、DB 查詢結果等）載入並驗證權重
 *
 * @param raw 任意 object，函式內部會做完整驗證
 * @returns 驗證通過的 CompanyWeights
 * @throws {Error} 驗證失敗時
 */
export function loadWeights(raw: unknown): CompanyWeights {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('loadWeights：輸入必須為非 null 的物件');
  }

  const obj = raw as Record<string, unknown>;
  const weights: CompanyWeights = {
    expiry: Number(obj['expiry']),
    urgency: Number(obj['urgency']),
    orderTime: Number(obj['orderTime']),
    customerTier: Number(obj['customerTier']),
    regionCluster: Number(obj['regionCluster']),
  };

  validateWeights(weights);
  return weights;
}

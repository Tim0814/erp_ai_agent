/**
 * 核心資料型別定義
 * 食品供應鏈訂單分配建議引擎
 */

// ─── 訂單 ────────────────────────────────────────────────────────────────────

export interface Order {
  /** 訂單唯一識別碼 */
  orderId: string;
  /** 客戶識別碼，對應 Customer.customerId */
  customerId: string;
  /** 商品識別碼，對應 Batch.productId；硬性規則會以此欄位篩掉不同商品的批次 */
  itemCode: string;
  /** 客戶要求的數量（單位：任意，與 Batch.availableQty 相同） */
  requestedQty: number;
  /** 客戶要求的交期 */
  requestedDate: Date;
  /** 下單時間，用於 orderTime 評分 */
  createdAt: Date;
}

// ─── 客戶 ────────────────────────────────────────────────────────────────────

export interface Customer {
  /** 客戶唯一識別碼 */
  customerId: string;
  /**
   * 客戶等級分數（0-100）
   * 數字越高代表越重要（VIP、大宗採購商等）
   */
  tierScore: number;
  /** 客戶所屬區域，用於 regionCluster 評分 */
  region: string;
}

// ─── 庫存批次 ─────────────────────────────────────────────────────────────────

export interface Batch {
  /** 批次唯一識別碼 */
  batchId: string;
  /** 商品識別碼 */
  productId: string;
  /**
   * 可用數量（即時扣減後的剩餘量）
   * 分配引擎在處理過程中會直接修改此欄位，避免超賣
   */
  availableQty: number;
  /** 批次效期 */
  expiryDate: Date;
  /** 倉庫所在區域，用於 regionCluster 評分 */
  warehouseRegion: string;
}

// ─── 公司權重設定 ──────────────────────────────────────────────────────────────

/**
 * 五個評分維度的加權設定
 * 必須透過外部設定檔或資料庫載入，不得寫死在程式邏輯裡
 * 五個欄位的總和必須等於 1（容許 ±0.001 浮點誤差）
 */
export interface CompanyWeights {
  /** 效期分數權重（食品業建議較高，預設 0.35） */
  expiry: number;
  /** 交期急迫性分數權重 */
  urgency: number;
  /** 下單先後分數權重 */
  orderTime: number;
  /** 客戶等級分數權重 */
  customerTier: number;
  /** 區域集群分數權重 */
  regionCluster: number;
}

// ─── 評分結果 ─────────────────────────────────────────────────────────────────

/** 單一批次針對某訂單的五個分項分數（皆為 0~100） */
export interface ScoreBreakdown {
  expiry: number;
  urgency: number;
  orderTime: number;
  customerTier: number;
  regionCluster: number;
}

/** 某批次對某訂單的完整評分結果 */
export interface BatchScore {
  batchId: string;
  scores: ScoreBreakdown;
  totalScore: number;
}

// ─── 分配輸出 ─────────────────────────────────────────────────────────────────

export type AllocationStatus = 'recommended' | 'blocked' | 'partial';

/**
 * 燈號顏色：代表每筆分配建議的風險等級
 * - green : 正常，可自動放行
 * - yellow: 模糊區間，建議人工複核
 * - red   : 存在明確風險，必須人工介入
 */
export type SignalColor = 'green' | 'yellow' | 'red';

/**
 * 每筆訂單的分配處理結果（對應需求文件 §6 輸出格式）
 */
export interface AllocationResult {
  orderId: string;
  status: AllocationStatus;
  /** 建議分配的批次 ID；blocked 時為 null */
  recommendedBatchId: string | null;
  /** 各分項分數；blocked 時各項為 0 */
  scores: ScoreBreakdown;
  /** 加權總分；blocked 時為 0 */
  totalScore: number;
  /** LLM 生成的白話解釋 */
  explanation: string;
  /** 被 blocked 的原因；非 blocked 時為 null */
  blockedReason: string | null;
  /** 燈號分流結果（green / yellow / red） */
  signalColor: SignalColor;
  /** 燈號判斷的原因說明 */
  signalReason: string;
}

// ─── 引擎輸入 ─────────────────────────────────────────────────────────────────

/** 傳入分配引擎的完整輸入資料 */
export interface AllocationInput {
  orders: Order[];
  /** 以 customerId 為 key 的客戶查詢表 */
  customers: Map<string, Customer>;
  /** 可分配批次清單（引擎會即時扣減 availableQty） */
  batches: Batch[];
  weights: CompanyWeights;
}

// 審核流程狀態（對應 allocation_recommendations.status）
export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

// 燈號（對應 traffic_light，語意與 status 完全獨立）
export type TrafficLight = 'green' | 'yellow' | 'red';

// 前端送出審核動作（含 overridden，API 層會轉換為 status='approved' + is_overridden=true）
export type ReviewAction = 'approved' | 'overridden' | 'rejected';

export interface Recommendation {
  id: string;
  sales_order: string;          // 父層訂單編號（如 SO-2026-00001）
  item_code: string;
  batch_id: string | null;
  warehouse: string;
  recommended_qty: number;

  // 評分
  score: number | string;       // 加權總分，DB 可能回傳字串，需 Number() 轉型
  fefo_score: number | string;
  urgency_score: number | string;
  order_time_score: number | string;
  customer_tier_score: number | string;
  region_score: number | string;

  // 燈號
  traffic_light: TrafficLight;
  traffic_light_reason: string | null;

  // 審核流程
  status: ReviewStatus;
  is_overridden: boolean;
  override_reason: string | null;
  overridden_by: string | null;
  overridden_at: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;

  // AI 說明
  rationale: string | null;

  // ERPNext 訂單建立者（來自 sales_orders.created_by，即 ERPNext owner 欄位）
  order_created_by: string | null;

  created_at: string;
}

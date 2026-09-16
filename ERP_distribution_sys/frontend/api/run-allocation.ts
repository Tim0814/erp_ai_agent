import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { runAllocation } from "../lib/allocationEngine.js";
import {
  fetchBatches,
  fetchCustomers,
  fetchOrders,
  fetchCompanyWeights,
} from "../lib/dataSource.js";
import type {
  AllocationInput,
  Order,
  Customer,
  Batch,
  CompanyWeights,
  AllocationResult,
} from "../lib/types.js";
import { DEFAULT_WEIGHTS, normalizeEnabledWeights } from "../lib/weights.js";

// ─── 輔助函式 ──────────────────────────────────────────────────────────────────

/**
 * 從 Supabase 查詢目前資料庫中所有「未取消」的分配紀錄，
 * 回傳已被佔用的 batch_id 集合。
 *
 * 查詢條件：status NOT IN ('cancelled')
 * 若查詢失敗，記錄警告並回傳空集合（降級處理，不阻斷主流程）。
 */
async function fetchExistingAllocatedBatchIds(
  supabase: SupabaseClient,
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("allocation_recommendations")
    .select("batch_id")
    .neq("status", "cancelled");

  if (error) {
    console.warn(
      "[燈號分流] 查詢現有分配紀錄失敗，跳過重複分配檢查：",
      error.message,
    );
    return new Set<string>();
  }

  const ids = new Set<string>();
  for (const row of data ?? []) {
    if (row.batch_id) ids.add(row.batch_id as string);
  }
  return ids;
}

// ─── Vercel Serverless Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = req.body ?? {};
    const shouldUseRequestBody =
      body &&
      typeof body === "object" &&
      Array.isArray((body as any).orders) &&
      Array.isArray((body as any).batches);

    const orders: Order[] = shouldUseRequestBody
      ? (body as any).orders.map((o: any) => ({
          ...o,
          parentOrderId: String(o.parentOrderId ?? o.orderId ?? ""),
          requestedDate: new Date(o.requestedDate),
          createdAt: new Date(o.createdAt),
        }))
      : await fetchOrders();

    const batches: Batch[] = shouldUseRequestBody
      ? (body as any).batches.map((b: any) => ({
          ...b,
          expiryDate: new Date(b.expiryDate),
        }))
      : await fetchBatches();

    const customers: Customer[] = shouldUseRequestBody
      ? ((body as any).customers ?? [])
      : await fetchCustomers();

    const customersMap = new Map<string, Customer>(
      customers.map((c: any) => [c.customerId, c as Customer]),
    );

    const dbWeights = shouldUseRequestBody ? null : await fetchCompanyWeights();
    const weights: CompanyWeights = shouldUseRequestBody
      ? ((body as any).weights ?? DEFAULT_WEIGHTS)
      : dbWeights
        ? normalizeEnabledWeights(dbWeights)
        : DEFAULT_WEIGHTS;

    // 建立 Supabase client（若環境變數存在）；查詢現有未取消的分配 batchId 集合
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;
    let supabase: SupabaseClient | null = null;
    let existingAllocatedBatchIds = new Set<string>();

    if (supabaseUrl && supabaseKey) {
      supabase = createClient(supabaseUrl, supabaseKey);
      // 在執行分配引擎之前先查詢，確保燈號判斷能偵測跨執行期的重複分配
      existingAllocatedBatchIds =
        await fetchExistingAllocatedBatchIds(supabase);
    }

    const input: AllocationInput = {
      orders,
      customers: customersMap,
      batches,
      weights,
    };

    // 將現有分配集合傳入引擎，引擎內部同步進行燈號分流
    const results: AllocationResult[] = await runAllocation(input, {
      existingAllocatedBatchIds,
    });

    const now = new Date().toISOString();
    const ordersById = new Map(orders.map((order) => [order.orderId, order]));
    const batchesById = new Map(batches.map((batch) => [batch.batchId, batch]));
    const processed = results.map((item) => ({
      sales_order: ordersById.get(item.orderId)?.parentOrderId ?? "",
      item_code: ordersById.get(item.orderId)?.itemCode ?? "",
      batch_id: item.recommendedBatchId,
      warehouse: item.recommendedBatchId
        ? batchesById.get(item.recommendedBatchId)?.warehouseRegion ||
          "unassigned"
        : "unassigned",
      recommended_qty: ordersById.get(item.orderId)?.requestedQty ?? 0,
      score: item.totalScore,
      rationale: item.explanation ?? "",
      fefo_score: item.scores.expiry,
      urgency_score: item.scores.urgency,
      order_time_score: item.scores.orderTime,
      customer_tier_score: item.scores.customerTier,
      region_score: item.scores.regionCluster,
      traffic_light: item.signalColor,
      traffic_light_reason: item.signalReason || null,
      status: "pending",
      created_at: now,
    }));

    if (supabase) {
      for (const rec of processed) {
        const { error } = await supabase
          .from("allocation_recommendations")
          .insert(rec);
        if (error) {
          console.error("Supabase insert error:", error);
          throw new Error(`Failed to insert recommendation: ${error.message}`);
        }
      }
    }

    return res
      .status(200)
      .json({ success: true, count: processed.length, data: processed });
  } catch (error) {
    console.error("Run allocation error:", error);
    return res.status(500).json({
      error: "Internal server error",
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomUUID } from 'crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { runAllocation } from '../lib/allocationEngine.js';
import type { AllocationInput, Order, Customer, Batch, CompanyWeights, AllocationResult } from '../lib/types.js';
import mockData from '../lib/mockData.json' with { type: 'json' };
import { DEFAULT_WEIGHTS } from '../lib/weights.js';

// ─── 輔助函式 ──────────────────────────────────────────────────────────────────

function calculateConfidence(status: string, totalScore: number): string {
  if (status === 'blocked') return 'manual';
  if (totalScore >= 80) return 'auto_recommend';
  if (totalScore >= 60) return 'review';
  return 'low_confidence';
}

/**
 * 從 Supabase 查詢目前資料庫中所有「未取消」的分配紀錄，
 * 回傳已被佔用的 batch_id 集合。
 *
 * 查詢條件：status NOT IN ('cancelled')
 * 若查詢失敗，記錄警告並回傳空集合（降級處理，不阻斷主流程）。
 */
async function fetchExistingAllocatedBatchIds(supabase: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('allocation_recommendations')
    .select('batch_id')
    .neq('status', 'cancelled');

  if (error) {
    console.warn('[燈號分流] 查詢現有分配紀錄失敗，跳過重複分配檢查：', error.message);
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
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body ?? {};
    const inputData =
      body && typeof body === 'object' && body.orders && body.batches
        ? body
        : mockData;

    // 反序列化：把 JSON 字串日期轉回 Date 物件
    const orders: Order[] = inputData.orders.map((o: any) => ({
      ...o,
      requestedDate: new Date(o.requestedDate),
      createdAt: new Date(o.createdAt),
    }));

    const batches: Batch[] = inputData.batches.map((b: any) => ({
      ...b,
      expiryDate: new Date(b.expiryDate),
    }));

    const customersMap = new Map<string, Customer>(
      (inputData.customers ?? []).map((c: any) => [c.customerId, c as Customer])
    );

    const weights: CompanyWeights = inputData.weights ?? DEFAULT_WEIGHTS;

    // 建立 Supabase client（若環境變數存在）；查詢現有未取消的分配 batchId 集合
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;
    let supabase: SupabaseClient | null = null;
    let existingAllocatedBatchIds = new Set<string>();

    if (supabaseUrl && supabaseKey) {
      supabase = createClient(supabaseUrl, supabaseKey);
      // 在執行分配引擎之前先查詢，確保燈號判斷能偵測跨執行期的重複分配
      existingAllocatedBatchIds = await fetchExistingAllocatedBatchIds(supabase);
    }

    const input: AllocationInput = { orders, customers: customersMap, batches, weights };

    // 將現有分配集合傳入引擎，引擎內部同步進行燈號分流
    const results: AllocationResult[] = await runAllocation(input, {
      existingAllocatedBatchIds,
    });

    const now = new Date().toISOString();
    const processed = results.map((item) => ({
      id: randomUUID(),
      order_id: item.orderId,
      batch_id: item.recommendedBatchId,
      status: item.status,
      confidence: calculateConfidence(item.status, item.totalScore),
      total_score: item.totalScore,
      scores_json: item.scores,
      explanation: item.explanation ?? '',
      blocked_reason: item.blockedReason ?? null,
      signal_color: item.signalColor,
      // ── 燈號分流欄位（與 status 核准流程互不相關）──────────────────────────
      // traffic_light：green / yellow / red，由 computeSignal() 判斷
      traffic_light: item.signalColor,
      // traffic_light_reason：燈號判斷的具體說明文字
      traffic_light_reason: item.signalReason || null,
      review_action: null,
      override_reason: null,
      reviewed_at: null,
      created_at: now,
    }));

    if (supabase) {
      for (const rec of processed) {
        const { error } = await supabase.from('allocation_recommendations').insert(rec);
        if (error) {
          console.error('Supabase insert error:', error);
          throw new Error(`Failed to insert recommendation: ${error.message}`);
        }
      }
    }

    return res.status(200).json({ success: true, count: processed.length, data: processed });
  } catch (error) {
    console.error('Run allocation error:', error);
    return res.status(500).json({ error: 'Internal server error', details: error instanceof Error ? error.message : String(error) });
  }
}

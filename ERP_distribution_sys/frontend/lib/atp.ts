import { createClient, type SupabaseClient } from '@supabase/supabase-js';

function getSupabaseClient(): SupabaseClient {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase 未設定，無法計算 ATP');
  }

  return createClient(supabaseUrl, supabaseKey);
}

function sumQuantities(rows: Array<{ actual_qty?: number; recommended_qty?: number }>, field: 'actual_qty' | 'recommended_qty'): number {
  return rows.reduce((total, row) => total + Number(row[field] ?? 0), 0);
}

function isBatchAvailable(expiryDate: string | null | undefined, asOfDate: string): boolean {
  return !expiryDate || expiryDate >= asOfDate;
}

/**
 * 計算指定商品在指定倉庫的可承諾庫存（ATP）。
 *
 * ATP = 現有庫存（inventory.actual_qty 加總）
 *     - 已分配但尚未出貨數量（approved recommendation.recommended_qty 加總）
 *
 * 已過期批次不列入可用庫存。asOfDate 未提供時使用今天的 UTC 日期；
 * 提供日期可用於回算歷史 ATP。
 *
 * 未來排程生產量目前沒有資料表，因此不納入本次計算。
 */
export async function calculateATP(itemCode: string, warehouse: string, asOfDate = new Date().toISOString().slice(0, 10)): Promise<number> {
  const supabase = getSupabaseClient();

  const [{ data: inventoryRows, error: inventoryError }, { data: batchRows, error: batchError }] = await Promise.all([
    supabase
    .from('inventory')
    .select('actual_qty, batch_id')
    .eq('item_code', itemCode)
    .eq('warehouse', warehouse),
    supabase
      .from('batches')
      .select('batch_id, expiry_date')
      .eq('item_code', itemCode),
  ]);

  if (inventoryError) {
    throw new Error(`查詢現有庫存失敗：${inventoryError.message}`);
  }
  if (batchError) {
    throw new Error(`查詢批次效期失敗：${batchError.message}`);
  }

  const expiryByBatch = new Map(
    (batchRows ?? []).map((row) => [String(row.batch_id), row.expiry_date as string | null]),
  );
  const availableInventoryRows = (inventoryRows ?? []).filter((row) =>
    isBatchAvailable(expiryByBatch.get(String(row.batch_id)), asOfDate),
  );

  const { data: allocationRows, error: allocationError } = await supabase
    .from('allocation_recommendations')
    .select('recommended_qty, batch_id')
    .eq('status', 'approved')
    .eq('item_code', itemCode)
    .eq('warehouse', warehouse);

  if (allocationError) {
    throw new Error(`查詢已分配數量失敗：${allocationError.message}`);
  }

  const currentInventory = sumQuantities(availableInventoryRows, 'actual_qty');
  const availableAllocationRows = (allocationRows ?? []).filter((row) =>
    isBatchAvailable(expiryByBatch.get(String(row.batch_id)), asOfDate),
  );
  const allocatedQuantity = sumQuantities(availableAllocationRows, 'recommended_qty');
  return currentInventory - allocatedQuantity;
}

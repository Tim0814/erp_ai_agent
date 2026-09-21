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

/**
 * 計算指定商品在指定倉庫的可承諾庫存（ATP）。
 *
 * ATP = 現有庫存（inventory.actual_qty 加總）
 *     - 已分配但尚未出貨數量（approved recommendation.recommended_qty 加總）
 *
 * 未來排程生產量目前沒有資料表，因此不納入本次計算。
 */
export async function calculateATP(itemCode: string, warehouse: string): Promise<number> {
  const supabase = getSupabaseClient();

  const { data: inventoryRows, error: inventoryError } = await supabase
    .from('inventory')
    .select('actual_qty')
    .eq('item_code', itemCode)
    .eq('warehouse', warehouse);

  if (inventoryError) {
    throw new Error(`查詢現有庫存失敗：${inventoryError.message}`);
  }

  const { data: allocationRows, error: allocationError } = await supabase
    .from('allocation_recommendations')
    .select('recommended_qty')
    .eq('status', 'approved')
    .eq('item_code', itemCode)
    .eq('warehouse', warehouse);

  if (allocationError) {
    throw new Error(`查詢已分配數量失敗：${allocationError.message}`);
  }

  const currentInventory = sumQuantities(inventoryRows ?? [], 'actual_qty');
  const allocatedQuantity = sumQuantities(allocationRows ?? [], 'recommended_qty');
  return currentInventory - allocatedQuantity;
}

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Batch, Customer, Order } from './types.js';
import mockData from './mockData.json' with { type: 'json' };

const FALLBACK_TIER_SCORE: Record<string, number> = {
  vip: 90,
  standard: 60,
  new: 30,
};

function getSupabaseClient(): SupabaseClient | null {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return null;
  }

  return createClient(supabaseUrl, supabaseKey);
}

function toDate(value: unknown, fallback: Date = new Date()): Date {
  if (value == null || value === '') {
    return fallback;
  }

  const date = new Date(value as string | number | Date);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function normalizeMockOrders(): Order[] {
  const rows = Array.isArray((mockData as { orders?: unknown[] }).orders) ? (mockData as { orders: any[] }).orders : [];

  return rows.map((row) => ({
    orderId: String(row.orderId ?? ''),
    parentOrderId: String(row.parentOrderId ?? row.orderId ?? ''),
    customerId: String(row.customerId ?? ''),
    itemCode: String(row.itemCode ?? ''),
    requestedQty: Number(row.requestedQty ?? 0),
    requestedDate: toDate(row.requestedDate),
    createdAt: toDate(row.createdAt),
  }));
}

function normalizeMockCustomers(): Customer[] {
  const rows = Array.isArray((mockData as { customers?: unknown[] }).customers) ? (mockData as { customers: any[] }).customers : [];

  return rows.map((row) => ({
    customerId: String(row.customerId ?? ''),
    tierScore: Number(row.tierScore ?? 0),
    region: String(row.region ?? ''),
  }));
}

function normalizeMockBatches(): Batch[] {
  const rows = Array.isArray((mockData as { batches?: unknown[] }).batches) ? (mockData as { batches: any[] }).batches : [];

  return rows.map((row) => ({
    batchId: String(row.batchId ?? ''),
    productId: String(row.productId ?? ''),
    availableQty: Number(row.availableQty ?? 0),
    expiryDate: toDate(row.expiryDate),
    warehouseRegion: String(row.warehouseRegion ?? ''),
  }));
}

export async function fetchOrders(): Promise<Order[]> {
  // 明確的開發模式旗標：只有 USE_MOCK_DATA=true 時才使用假資料
  if (process.env.USE_MOCK_DATA === 'true') {
    return normalizeMockOrders();
  }

  const supabase = getSupabaseClient();

  if (!supabase) {
    const msg = '[dataSource] fetchOrders 查詢失敗，原因：Supabase 環境變數未設定（SUPABASE_URL / SUPABASE_ANON_KEY）';
    console.error(msg);
    throw new Error(msg);
  }

  const { data: salesOrders, error: salesOrdersError } = await supabase
    .from('sales_orders')
    .select('name, customer_name, delivery_date, created_at')
    .eq('status', 'Draft');

  if (salesOrdersError) {
    const msg = `[dataSource] fetchOrders 查詢失敗，原因：sales_orders 查詢錯誤 — ${salesOrdersError.message}`;
    console.error(msg);
    throw new Error(msg);
  }

  if (!Array.isArray(salesOrders)) {
    const msg = '[dataSource] fetchOrders 查詢失敗，原因：sales_orders 回傳非陣列';
    console.error(msg);
    throw new Error(msg);
  }

  const orderNames = salesOrders.map((order: any) => order.name);
  const { data: items, error: itemsError } = orderNames.length === 0
    ? { data: [], error: null }
    : await supabase
      .from('sales_order_items')
      .select('name, parent, qty, delivery_date, item_code')
      .in('parent', orderNames);

  if (itemsError) {
    const msg = `[dataSource] fetchOrders 查詢失敗，原因：sales_order_items 查詢錯誤 — ${itemsError.message}`;
    console.error(msg);
    throw new Error(msg);
  }

  if (!Array.isArray(items)) {
    const msg = '[dataSource] fetchOrders 查詢失敗，原因：sales_order_items 回傳非陣列';
    console.error(msg);
    throw new Error(msg);
  }

  const ordersByName = new Map(salesOrders.map((order: any) => [order.name, order]));
  return items.map((row: any) => {
    const order = ordersByName.get(row.parent);
    return {
      orderId: String(row.name ?? row.id ?? ''),
      parentOrderId: String(row.parent ?? ''),
      customerId: String(order?.customer_name ?? ''),
      itemCode: String(row.item_code ?? ''),
      requestedQty: Number(row.qty ?? 0),
      requestedDate: toDate(row.delivery_date ?? order?.delivery_date),
      createdAt: toDate(order?.created_at),
    };
  });
}

/**
 * 讀取指定商品、且父訂單仍為 Draft 的訂單明細。
 * 局部重新分配僅應處理這些仍可分配的需求，不能把已取消或完成的訂單帶回引擎。
 */
export async function fetchDraftOrdersByItemCode(itemCode: string): Promise<Order[]> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    throw new Error('Supabase not configured');
  }

  const { data: salesOrders, error: salesOrdersError } = await supabase
    .from('sales_orders')
    .select('name, customer_name, delivery_date, created_at')
    .eq('status', 'Draft');

  if (salesOrdersError) {
    throw new Error(`Failed to fetch draft sales orders: ${salesOrdersError.message}`);
  }

  const orderNames = salesOrders?.map((order: any) => order.name) ?? [];
  const { data, error } = orderNames.length === 0
    ? { data: [], error: null }
    : await supabase
    .from('sales_order_items')
    .select('name, parent, qty, delivery_date, item_code')
    .eq('item_code', itemCode)
    .in('parent', orderNames);

  if (error) {
    throw new Error(`Failed to fetch draft orders: ${error.message}`);
  }

  const ordersByName = new Map((salesOrders ?? []).map((order: any) => [order.name, order]));
  return (data ?? []).map((row: any) => {
    const order = ordersByName.get(row.parent);
    return {
    orderId: String(row.name ?? row.id ?? ''),
    parentOrderId: String(row.parent ?? ''),
    customerId: String(order?.customer_name ?? ''),
    itemCode: String(row.item_code ?? ''),
    requestedQty: Number(row.qty ?? 0),
    requestedDate: toDate(row.delivery_date ?? order?.delivery_date),
    createdAt: toDate(order?.created_at),
    };
  });
}

export async function fetchCustomers(): Promise<Customer[]> {
  // 明確的開發模式旗標：只有 USE_MOCK_DATA=true 時才使用假資料
  if (process.env.USE_MOCK_DATA === 'true') {
    return normalizeMockCustomers();
  }

  const supabase = getSupabaseClient();

  if (!supabase) {
    const msg = '[dataSource] fetchCustomers 查詢失敗，原因：Supabase 環境變數未設定（SUPABASE_URL / SUPABASE_ANON_KEY）';
    console.error(msg);
    throw new Error(msg);
  }

  const { data, error } = await supabase
    .from('customers')
    .select('customer_name, customer_tier, territory');

  if (error) {
    const msg = `[dataSource] fetchCustomers 查詢失敗，原因：${error.message}`;
    console.error(msg);
    throw new Error(msg);
  }

  if (!Array.isArray(data)) {
    const msg = '[dataSource] fetchCustomers 查詢失敗，原因：customers 回傳非陣列';
    console.error(msg);
    throw new Error(msg);
  }

  return data.map((row: any) => ({
    customerId: String(row.customer_name ?? ''),
    tierScore: FALLBACK_TIER_SCORE[String(row.customer_tier ?? '').toLowerCase()] ?? 0,
    region: String(row.territory ?? ''),
  }));
}

export async function fetchBatches(): Promise<Batch[]> {
  // 明確的開發模式旗標：只有 USE_MOCK_DATA=true 時才使用假資料
  if (process.env.USE_MOCK_DATA === 'true') {
    return normalizeMockBatches();
  }

  const supabase = getSupabaseClient();

  if (!supabase) {
    const msg = '[dataSource] fetchBatches 查詢失敗，原因：Supabase 環境變數未設定（SUPABASE_URL / SUPABASE_ANON_KEY）';
    console.error(msg);
    throw new Error(msg);
  }

  const [batchesResult, inventoryResult] = await Promise.all([
    supabase.from('batches').select('batch_id, item_code, expiry_date'),
    supabase.from('inventory').select('batch_id, actual_qty, warehouse'),
  ]);

  const batchError = batchesResult.error;
  const inventoryError = inventoryResult.error;

  if (batchError) {
    const msg = `[dataSource] fetchBatches 查詢失敗，原因：batches 查詢錯誤 — ${batchError.message}`;
    console.error(msg);
    throw new Error(msg);
  }

  if (inventoryError) {
    const msg = `[dataSource] fetchBatches 查詢失敗，原因：inventory 查詢錯誤 — ${inventoryError.message}`;
    console.error(msg);
    throw new Error(msg);
  }

  if (!Array.isArray(batchesResult.data) || !Array.isArray(inventoryResult.data)) {
    const msg = '[dataSource] fetchBatches 查詢失敗，原因：batches 或 inventory 回傳非陣列';
    console.error(msg);
    throw new Error(msg);
  }

  // 本次範圍刻意不做跨倉分拆：同一批次只取庫存量最大的倉庫，
  // 避免合併後的數量超過單一倉庫可實際出貨的量，也讓區域評分維持單一值。
  const inventoryByBatch = new Map<string, { actualQty: number; warehouseRegion: string }>();

  for (const row of inventoryResult.data as any[]) {
    const batchId = String(row.batch_id ?? '');
    if (!batchId) continue;

    const actualQty = Number(row.actual_qty ?? 0);
    const current = inventoryByBatch.get(batchId);
    if (!current || actualQty > current.actualQty) {
      inventoryByBatch.set(batchId, {
        actualQty,
        warehouseRegion: String(row.warehouse ?? ''),
      });
    }
  }

  return (batchesResult.data as any[]).map((row) => {
    const batchId = String(row.batch_id ?? '');
    const inventoryInfo = inventoryByBatch.get(batchId) ?? { actualQty: 0, warehouseRegion: '' };

    return {
      batchId,
      productId: String(row.item_code ?? ''),
      availableQty: Number(inventoryInfo.actualQty ?? 0),
      expiryDate: toDate(row.expiry_date),
      warehouseRegion: inventoryInfo.warehouseRegion,
    };
  });
}

export async function fetchCompanyWeights(): Promise<Record<string, unknown> | null> {
  const supabase = getSupabaseClient();

  if (!supabase) return null;

  const { data, error } = await supabase
    .from('company_weights')
    .select('fefo_weight, urgency_weight, order_time_weight, customer_tier_weight, region_weight, fefo_enabled, urgency_enabled, order_time_enabled, customer_tier_enabled, region_enabled')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn('[dataSource] fetchCompanyWeights() Supabase query failed:', error.message);
    return null;
  }

  return data as Record<string, unknown> | null;
}

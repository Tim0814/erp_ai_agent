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
  const supabase = getSupabaseClient();

  if (supabase) {
    const { data, error } = await supabase
      .from('sales_order_items')
      .select('name, parent, qty, delivery_date, item_code, sales_orders!parent!inner(name, customer_name, delivery_date, created_at, status)')
      .eq('sales_orders.status', 'Draft');

    if (!error && Array.isArray(data)) {
      return data.map((row: any) => ({
        orderId: String(row.name ?? row.id ?? ''),
        parentOrderId: String(row.sales_orders?.name ?? row.parent ?? ''),
        customerId: String(row.sales_orders?.customer_name ?? ''),
        itemCode: String(row.item_code ?? ''),
        requestedQty: Number(row.qty ?? 0),
        requestedDate: toDate(row.delivery_date ?? row.sales_orders?.delivery_date),
        createdAt: toDate(row.sales_orders?.created_at),
      }));
    }

    console.warn('[dataSource] fetchOrders() Supabase query failed, fallback to mock data:', error?.message ?? 'unknown error');
  }

  return normalizeMockOrders();
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

  const { data, error } = await supabase
    .from('sales_order_items')
    .select('name, parent, qty, delivery_date, item_code, sales_orders!parent!inner(name, customer_name, delivery_date, created_at, status)')
    .eq('item_code', itemCode)
    .eq('sales_orders.status', 'Draft');

  if (error) {
    throw new Error(`Failed to fetch draft orders: ${error.message}`);
  }

  return (data ?? []).map((row: any) => ({
    orderId: String(row.name ?? row.id ?? ''),
    parentOrderId: String(row.sales_orders?.name ?? row.parent ?? ''),
    customerId: String(row.sales_orders?.customer_name ?? ''),
    itemCode: String(row.item_code ?? ''),
    requestedQty: Number(row.qty ?? 0),
    requestedDate: toDate(row.delivery_date ?? row.sales_orders?.delivery_date),
    createdAt: toDate(row.sales_orders?.created_at),
  }));
}

export async function fetchCustomers(): Promise<Customer[]> {
  const supabase = getSupabaseClient();

  if (supabase) {
    const { data, error } = await supabase
      .from('customers')
      .select('customer_name, customer_tier, territory');

    if (!error && Array.isArray(data)) {
      return data.map((row: any) => ({
        customerId: String(row.customer_name ?? ''),
        tierScore: FALLBACK_TIER_SCORE[String(row.customer_tier ?? '').toLowerCase()] ?? 0,
        region: String(row.territory ?? ''),
      }));
    }

    console.warn('[dataSource] fetchCustomers() Supabase query failed, fallback to mock data:', error?.message ?? 'unknown error');
  }

  return normalizeMockCustomers();
}

export async function fetchBatches(): Promise<Batch[]> {
  const supabase = getSupabaseClient();

  if (supabase) {
    const [batchesResult, inventoryResult] = await Promise.all([
      supabase.from('batches').select('batch_id, item_code, expiry_date'),
      supabase.from('inventory').select('batch_id, actual_qty, warehouse'),
    ]);

    const batchError = batchesResult.error;
    const inventoryError = inventoryResult.error;

    if (!batchError && !inventoryError && Array.isArray(batchesResult.data) && Array.isArray(inventoryResult.data)) {
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

    console.warn('[dataSource] fetchBatches() Supabase query failed, fallback to mock data:', {
      batchesError: batchError?.message ?? 'none',
      inventoryError: inventoryError?.message ?? 'none',
    });
  }

  return normalizeMockBatches();
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

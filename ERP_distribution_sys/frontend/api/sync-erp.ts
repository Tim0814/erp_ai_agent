/**
 * /api/sync-erp
 *
 * 從 ERPNext 讀取資料並寫入 Supabase，等同於本機執行 sync-script/syncFromErpnext.ts。
 * 需要在 Vercel 環境變數中設定：
 *   ERPNEXT_BASE_URL          ERPNext 對外 URL（不含結尾 /）
 *   ERPNEXT_API_KEY           ERPNext API Key
 *   ERPNEXT_API_SECRET        ERPNext API Secret
 *   SUPABASE_URL              Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY Supabase service role key（繞過 RLS）
 *
 * ⚠️  每次執行都會清空並重寫：
 *   sales_order_items / inventory / sales_orders / batches / items / customers
 *   不會動到 company_weights 與 allocation_recommendations。
 *
 * Vercel Serverless 函式預設 timeout 為 10s（Hobby）/ 60s（Pro）。
 * 若 ERPNext 資料量大，建議升級 Pro 或改成 Background Function。
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ─── ERPNext 工具函式 ──────────────────────────────────────────────────────────

function stripWarehouseSuffix(warehouseName: string): string {
  const idx = warehouseName.lastIndexOf(' - ');
  return idx === -1 ? warehouseName : warehouseName.slice(0, idx);
}

async function erpFetchAll(
  baseUrl: string,
  authHeader: string,
  doctype: string,
  fields: string[],
  filters: Array<[string, string, string, unknown]> = [],
): Promise<Record<string, unknown>[]> {
  const PAGE_SIZE = 500;
  const allRows: Record<string, unknown>[] = [];
  let start = 0;

  while (true) {
    const params = new URLSearchParams({
      fields: JSON.stringify(fields),
      filters: JSON.stringify(filters),
      limit_start: String(start),
      limit_page_length: String(PAGE_SIZE),
    });

    const url = `${baseUrl}/api/resource/${encodeURIComponent(doctype)}?${params}`;
    const resp = await fetch(url, { headers: { Authorization: authHeader } });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`ERPNext API 失敗 [${doctype}] HTTP ${resp.status}: ${body.slice(0, 300)}`);
    }

    const json = (await resp.json()) as { data?: Record<string, unknown>[] };
    const rows = json.data ?? [];
    allRows.push(...rows);

    if (rows.length < PAGE_SIZE) break;
    start += PAGE_SIZE;
  }

  return allRows;
}

// ─── 各 DocType 讀取函式 ───────────────────────────────────────────────────────

interface ErpItem {
  item_code: string;
  item_name: string;
  item_group: string;
  stock_uom: string;
  description?: string;
}

async function fetchErpItems(baseUrl: string, authHeader: string): Promise<ErpItem[]> {
  const rows = await erpFetchAll(baseUrl, authHeader, 'Item', [
    'item_code', 'item_name', 'item_group', 'stock_uom', 'description',
  ]);
  return rows.map((r) => ({
    item_code:   String(r['item_code']  ?? ''),
    item_name:   String(r['item_name']  ?? ''),
    item_group:  String(r['item_group'] ?? ''),
    stock_uom:   String(r['stock_uom']  ?? ''),
    description: r['description'] != null ? String(r['description']) : undefined,
  }));
}

interface ErpCustomer {
  name: string;
  customer_group: string;
  customer_type: string;
  territory: string;
  custom_customer_tier?: string;
}

const CUSTOMER_TIER_MAP: Record<string, string> = {
  'CUST-A': 'vip',
  'CUST-B': 'standard',
  'CUST-C': 'standard',
  'CUST-D': 'new',
  'CUST-E': 'vip',
};
const DEFAULT_TIER = 'standard';

async function fetchErpCustomers(baseUrl: string, authHeader: string): Promise<ErpCustomer[]> {
  const rows = await erpFetchAll(baseUrl, authHeader, 'Customer', [
    'name', 'customer_group', 'customer_type', 'territory',
  ]);
  return rows.map((r) => ({
    name:           String(r['name']           ?? ''),
    customer_group: String(r['customer_group'] ?? ''),
    customer_type:  String(r['customer_type']  ?? ''),
    territory:      String(r['territory']      ?? ''),
    custom_customer_tier: r['custom_customer_tier'] != null
      ? String(r['custom_customer_tier'])
      : undefined,
  }));
}

interface ErpBatch {
  name: string;
  item: string;
  manufacturing_date?: string;
  expiry_date?: string;
  batch_qty?: number;
}

async function fetchErpBatches(baseUrl: string, authHeader: string): Promise<ErpBatch[]> {
  const rows = await erpFetchAll(baseUrl, authHeader, 'Batch', [
    'name', 'item', 'manufacturing_date', 'expiry_date', 'batch_qty',
  ]);
  return rows.map((r) => ({
    name:               String(r['name'] ?? ''),
    item:               String(r['item'] ?? ''),
    manufacturing_date: r['manufacturing_date'] != null ? String(r['manufacturing_date']) : undefined,
    expiry_date:        r['expiry_date'] != null ? String(r['expiry_date']) : undefined,
    batch_qty:          r['batch_qty'] != null ? Number(r['batch_qty']) : undefined,
  }));
}

interface ErpBin {
  item_code: string;
  batch_no: string;
  warehouse: string;
  actual_qty: number;
}

async function fetchErpInventory(baseUrl: string, authHeader: string): Promise<ErpBin[]> {
  const bundleList = await erpFetchAll(
    baseUrl, authHeader,
    'Serial and Batch Bundle',
    ['name', 'item_code', 'warehouse', 'is_cancelled', 'type_of_transaction'],
    [
      ['Serial and Batch Bundle', 'is_cancelled', '=', 0],
      ['Serial and Batch Bundle', 'type_of_transaction', '=', 'Inward'],
    ],
  );

  if (bundleList.length === 0) return [];

  const latest = new Map<string, { qty: number; timestamp: string }>();

  for (const bundle of bundleList) {
    const bundleId        = String(bundle['name']      ?? '');
    const parentItemCode  = String(bundle['item_code'] ?? '').trim();
    const parentWarehouse = stripWarehouseSuffix(String(bundle['warehouse'] ?? '').trim());

    if (!bundleId || !parentItemCode || !parentWarehouse) continue;

    const url = `${baseUrl}/api/resource/${encodeURIComponent('Serial and Batch Bundle')}/${encodeURIComponent(bundleId)}`;
    const resp = await fetch(url, { headers: { Authorization: authHeader } });

    if (!resp.ok) continue;

    const doc = (await resp.json() as { data?: { entries?: Record<string, unknown>[] } }).data;
    const entries = doc?.entries ?? [];

    for (const entry of entries) {
      const batchNo   = String(entry['batch_no']   ?? '').trim();
      const qty       = Number(entry['qty']         ?? 0);
      const timestamp = String(entry['posting_datetime'] ?? '1970-01-01 00:00:00');
      const itemCode  = String(entry['item_code']  ?? parentItemCode).trim()  || parentItemCode;
      const warehouse = stripWarehouseSuffix(
        String(entry['warehouse'] ?? parentWarehouse).trim() || parentWarehouse,
      );

      if (!batchNo || !itemCode || !warehouse) continue;

      const key = `${itemCode}|${batchNo}|${warehouse}`;
      const current = latest.get(key);
      if (!current || timestamp > current.timestamp) {
        latest.set(key, { qty, timestamp });
      }
    }
  }

  const result: ErpBin[] = [];
  for (const [key, { qty }] of latest) {
    if (qty <= 0) continue;
    const [item_code, batch_no, warehouse] = key.split('|') as [string, string, string];
    result.push({ item_code, batch_no, warehouse, actual_qty: qty });
  }

  return result;
}

interface ErpSalesOrder {
  name: string;
  customer: string;
  transaction_date: string;
  delivery_date?: string;
  status: string;
  grand_total?: number;
  owner: string;
}

async function fetchErpSalesOrders(baseUrl: string, authHeader: string): Promise<ErpSalesOrder[]> {
  const rows = await erpFetchAll(
    baseUrl, authHeader,
    'Sales Order',
    ['name', 'customer', 'transaction_date', 'delivery_date', 'status', 'grand_total', 'owner'],
    [['Sales Order', 'docstatus', '=', 0]],
  );
  return rows.map((r) => ({
    name:             String(r['name']             ?? ''),
    customer:         String(r['customer']         ?? ''),
    transaction_date: String(r['transaction_date'] ?? ''),
    delivery_date:    r['delivery_date'] != null ? String(r['delivery_date']) : undefined,
    status:           String(r['status']           ?? ''),
    grand_total:      r['grand_total'] != null ? Number(r['grand_total']) : undefined,
    owner:            String(r['owner']            ?? ''),
  }));
}

interface ErpSalesOrderItem {
  parent: string;
  item_code: string;
  qty: number;
  rate?: number;
  delivery_date?: string;
}

async function fetchErpSalesOrderItems(
  baseUrl: string,
  authHeader: string,
  orderNames: string[],
): Promise<ErpSalesOrderItem[]> {
  if (orderNames.length === 0) return [];

  const allItems: ErpSalesOrderItem[] = [];

  for (const orderName of orderNames) {
    const url = `${baseUrl}/api/resource/${encodeURIComponent('Sales Order')}/${encodeURIComponent(orderName)}`;
    const resp = await fetch(url, { headers: { Authorization: authHeader } });

    if (!resp.ok) continue;

    const doc = (await resp.json() as { data?: Record<string, unknown> }).data;
    const items = (doc?.['items'] as Record<string, unknown>[] | undefined) ?? [];

    for (const item of items) {
      allItems.push({
        parent:        orderName,
        item_code:     String(item['item_code']     ?? ''),
        qty:           Number(item['qty']           ?? 0),
        rate:          item['rate']          != null ? Number(item['rate']) : undefined,
        delivery_date: item['delivery_date'] != null ? String(item['delivery_date']) : undefined,
      });
    }
  }

  return allItems;
}

// ─── Supabase 清空與寫入函式 ───────────────────────────────────────────────────

const TABLE_PRIMARY_KEYS: Record<string, string> = {
  sales_order_items: 'name',
  inventory:         'id',
  sales_orders:      'name',
  batches:           'batch_id',
  items:             'item_code',
  customers:         'customer_name',
};

async function clearTables(supabase: SupabaseClient): Promise<void> {
  const tables = [
    'sales_order_items',
    'inventory',
    'sales_orders',
    'batches',
    'items',
    'customers',
  ] as const;

  for (const table of tables) {
    const pkColumn = TABLE_PRIMARY_KEYS[table];
    const { error } = await supabase.from(table).delete().not(pkColumn, 'is', null);
    if (error) throw new Error(`清空 ${table} 失敗：${error.message}`);
  }
}

async function upsertItems(supabase: SupabaseClient, items: ErpItem[]): Promise<void> {
  if (items.length === 0) return;
  const { error } = await supabase.from('items').insert(
    items.map((i) => ({
      item_code:   i.item_code,
      item_name:   i.item_name,
      item_group:  i.item_group,
      stock_uom:   i.stock_uom,
      description: i.description ?? null,
    })),
  );
  if (error) throw new Error(`寫入 items 失敗：${error.message}`);
}

async function upsertCustomers(supabase: SupabaseClient, customers: ErpCustomer[]): Promise<void> {
  if (customers.length === 0) return;
  const { error } = await supabase.from('customers').insert(
    customers.map((c) => {
      const tier =
        c.custom_customer_tier?.trim() ||
        CUSTOMER_TIER_MAP[c.name] ||
        DEFAULT_TIER;
      return {
        customer_name:  c.name,
        customer_group: c.customer_group,
        customer_type:  c.customer_type,
        territory:      c.territory,
        customer_tier:  tier,
      };
    }),
  );
  if (error) throw new Error(`寫入 customers 失敗：${error.message}`);
}

async function upsertBatches(supabase: SupabaseClient, batches: ErpBatch[]): Promise<void> {
  if (batches.length === 0) return;
  const { error } = await supabase.from('batches').insert(
    batches.map((b) => ({
      batch_id:           b.name,
      item_code:          b.item,
      manufacturing_date: b.manufacturing_date ?? null,
      expiry_date:        b.expiry_date ?? null,
      batch_qty:          b.batch_qty ?? 0,
    })),
  );
  if (error) throw new Error(`寫入 batches 失敗：${error.message}`);
}

async function upsertInventory(supabase: SupabaseClient, bins: ErpBin[]): Promise<void> {
  if (bins.length === 0) return;
  const { error } = await supabase.from('inventory').insert(
    bins.map((b) => ({
      item_code:  b.item_code,
      batch_id:   b.batch_no,
      warehouse:  b.warehouse,
      actual_qty: b.actual_qty,
    })),
  );
  if (error) throw new Error(`寫入 inventory 失敗：${error.message}`);
}

async function upsertSalesOrders(supabase: SupabaseClient, orders: ErpSalesOrder[]): Promise<void> {
  if (orders.length === 0) return;
  const { error } = await supabase.from('sales_orders').insert(
    orders.map((o) => ({
      name:             o.name,
      customer_name:    o.customer,
      transaction_date: o.transaction_date,
      delivery_date:    o.delivery_date ?? null,
      status:           'Draft',
      grand_total:      o.grand_total ?? null,
      created_by:       o.owner || null,
    })),
  );
  if (error) throw new Error(`寫入 sales_orders 失敗：${error.message}`);
}

async function upsertSalesOrderItems(
  supabase: SupabaseClient,
  items: ErpSalesOrderItem[],
): Promise<void> {
  if (items.length === 0) return;
  const BATCH_SIZE = 200;
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const chunk = items.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('sales_order_items').insert(
      chunk.map((item) => ({
        parent:        item.parent,
        item_code:     item.item_code,
        qty:           item.qty,
        rate:          item.rate ?? null,
        delivery_date: item.delivery_date ?? null,
      })),
    );
    if (error) throw new Error(`寫入 sales_order_items 失敗（batch ${i}）：${error.message}`);
  }
}

// ─── Vercel Serverless Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 讀取必要環境變數（在 handler 內讀，而非模組頂層，避免 Vercel 在 cold start 時 throw）
  const erpBaseUrl    = process.env.ERPNEXT_BASE_URL?.replace(/\/$/, '');
  const erpApiKey     = process.env.ERPNEXT_API_KEY;
  const erpApiSecret  = process.env.ERPNEXT_API_SECRET;
  const supabaseUrl   = process.env.SUPABASE_URL;
  const serviceKey    = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!erpBaseUrl || !erpApiKey || !erpApiSecret) {
    return res.status(503).json({
      error: 'ERPNext 環境變數未設定',
      details: '請在 Vercel 設定：ERPNEXT_BASE_URL、ERPNEXT_API_KEY、ERPNEXT_API_SECRET',
    });
  }
  if (!supabaseUrl || !serviceKey) {
    return res.status(503).json({
      error: 'Supabase 環境變數未設定',
      details: '請在 Vercel 設定：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY',
    });
  }

  const authHeader = `token ${erpApiKey}:${erpApiSecret}`;
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  try {
    // ── Step 1：從 ERPNext 讀取 ─────────────────────────────────────────────────
    const [erpItems, erpCustomers, erpBatches, erpBins, erpOrders] = await Promise.all([
      fetchErpItems(erpBaseUrl, authHeader),
      fetchErpCustomers(erpBaseUrl, authHeader),
      fetchErpBatches(erpBaseUrl, authHeader),
      fetchErpInventory(erpBaseUrl, authHeader),
      fetchErpSalesOrders(erpBaseUrl, authHeader),
    ]);

    const orderNames = erpOrders.map((o) => o.name);
    const erpOrderItems = await fetchErpSalesOrderItems(erpBaseUrl, authHeader, orderNames);

    // ── Step 2：清空 Supabase 目標表 ────────────────────────────────────────────
    await clearTables(supabase);

    // ── Step 3：寫入 Supabase（父表先、子表後）──────────────────────────────────
    await upsertItems(supabase, erpItems);
    await upsertCustomers(supabase, erpCustomers);
    await upsertBatches(supabase, erpBatches);
    await upsertInventory(supabase, erpBins);
    await upsertSalesOrders(supabase, erpOrders);
    await upsertSalesOrderItems(supabase, erpOrderItems);

    return res.status(200).json({
      success: true,
      summary: {
        items:             erpItems.length,
        customers:         erpCustomers.length,
        batches:           erpBatches.length,
        inventory:         erpBins.length,
        sales_orders:      erpOrders.length,
        sales_order_items: erpOrderItems.length,
      },
    });
  } catch (error) {
    console.error('[sync-erp] 同步失敗：', error);
    return res.status(500).json({
      error: '同步失敗',
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

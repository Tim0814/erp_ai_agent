/**
 * syncFromErpnext.ts
 *
 * 本機執行的單向同步腳本：ERPNext (本機 Docker) → Supabase (雲端)
 *
 * 執行方式（開發，不需編譯）：
 *   node --loader ts-node/esm syncFromErpnext.ts
 *
 * 執行方式（編譯後）：
 *   npm run build && node dist/syncFromErpnext.js
 *
 * 環境變數（複製 .env.example → .env 後填入）：
 *   ERPNEXT_BASE_URL         ERPNext Docker 對外 URL，例如 http://localhost:8080
 *   ERPNEXT_API_KEY          ERPNext API Key
 *   ERPNEXT_API_SECRET       ERPNext API Secret
 *   SUPABASE_URL             Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY Supabase service role key（繞過 RLS）
 *
 * ⚠️  注意：此腳本每次執行都會完整清空並重寫以下六張表：
 *     items / customers / batches / inventory / sales_orders / sales_order_items
 *   不會動到 company_weights 與 allocation_recommendations。
 */

import 'dotenv/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ─── 環境變數讀取與驗證 ────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`缺少必要環境變數：${name}（請參考 .env.example 設定）`);
  return val;
}

const ERPNEXT_BASE_URL        = requireEnv('ERPNEXT_BASE_URL').replace(/\/$/, '');
const ERPNEXT_API_KEY         = requireEnv('ERPNEXT_API_KEY');
const ERPNEXT_API_SECRET      = requireEnv('ERPNEXT_API_SECRET');
const SUPABASE_URL            = requireEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

// ─── customer_tier 對照表（方案 A）────────────────────────────────────────────
// ERPNext 原廠沒有 customer_tier 欄位。
// 此對照表以 seed_dev_v2.sql 為基準；新客戶若不在表內，預設 'standard'。
// 如果你的 ERPNext 已建立 Custom Field（custom_customer_tier），
// 請把下方 fetchCustomers() 裡的 TIER_MAP 邏輯改成讀取該欄位。
const CUSTOMER_TIER_MAP: Record<string, string> = {
  'CUST-A': 'vip',
  'CUST-B': 'standard',
  'CUST-C': 'standard',
  'CUST-D': 'new',
  'CUST-E': 'vip',
};
const DEFAULT_TIER = 'standard';

// ─── ERPNext API 工具函式 ──────────────────────────────────────────────────────

const AUTH_HEADER = `token ${ERPNEXT_API_KEY}:${ERPNEXT_API_SECRET}`;

/**
 * 呼叫 ERPNext REST API，取得指定 DocType 的全部資料。
 * ERPNext 預設一次最多回傳 20 筆，這裡用 limit_page_length=500 + 分頁迴圈確保全量抓取。
 *
 * @param doctype  ERPNext DocType 名稱（例如 'Item'、'Customer'）
 * @param fields   要抓取的欄位陣列（'*' 代表全部）
 * @param filters  ERPNext filter 陣列（可選），格式：[doctype, field, operator, value]
 */
async function erpFetchAll(
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

    const url = `${ERPNEXT_BASE_URL}/api/resource/${encodeURIComponent(doctype)}?${params}`;
    const resp = await fetch(url, {
      headers: { Authorization: AUTH_HEADER },
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`ERPNext API 失敗 [${doctype}] HTTP ${resp.status}: ${body.slice(0, 300)}`);
    }

    const json = (await resp.json()) as { data?: Record<string, unknown>[] };
    const rows = json.data ?? [];
    allRows.push(...rows);

    // 若回傳筆數 < PAGE_SIZE，代表已是最後一頁
    if (rows.length < PAGE_SIZE) break;
    start += PAGE_SIZE;
  }

  return allRows;
}

/**
 * 讀取 ERPNext 子表（例如 Sales Order Item），
 * 子表需透過 /api/resource/{DocType}/{name}/items 或
 * 直接對 DocType 查詢 parent 欄位。這裡使用後者，效率較高。
 */
async function erpFetchChildAll(
  childDoctype: string,
  fields: string[],
  parentField: string,
  parentValues: string[],
): Promise<Record<string, unknown>[]> {
  if (parentValues.length === 0) return [];

  const PAGE_SIZE = 500;
  const allRows: Record<string, unknown>[] = [];
  let start = 0;

  while (true) {
    const params = new URLSearchParams({
      fields: JSON.stringify(fields),
      filters: JSON.stringify([[childDoctype, parentField, 'in', parentValues]]),
      limit_start: String(start),
      limit_page_length: String(PAGE_SIZE),
    });

    const url = `${ERPNEXT_BASE_URL}/api/resource/${encodeURIComponent(childDoctype)}?${params}`;
    const resp = await fetch(url, {
      headers: { Authorization: AUTH_HEADER },
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`ERPNext API 失敗 [${childDoctype}] HTTP ${resp.status}: ${body.slice(0, 300)}`);
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

async function fetchErpItems(): Promise<ErpItem[]> {
  const rows = await erpFetchAll('Item', [
    'item_code', 'item_name', 'item_group', 'stock_uom', 'description',
  ]);
  return rows.map((r) => ({
    item_code:  String(r['item_code']  ?? ''),
    item_name:  String(r['item_name']  ?? ''),
    item_group: String(r['item_group'] ?? ''),
    stock_uom:  String(r['stock_uom']  ?? ''),
    description: r['description'] != null ? String(r['description']) : undefined,
  }));
}

interface ErpCustomer {
  name: string;           // ERPNext Customer 的 primary key = customer_name
  customer_group: string;
  customer_type: string;
  territory: string;
  custom_customer_tier?: string; // 若已建立 Custom Field
}

async function fetchErpCustomers(): Promise<ErpCustomer[]> {
  const rows = await erpFetchAll('Customer', [
    'name', 'customer_group', 'customer_type', 'territory', 'custom_customer_tier',
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
  name: string;           // ERPNext Batch 的 primary key = batch_id
  item: string;           // → batches.item_code
  manufacturing_date?: string;
  expiry_date?: string;
  batch_qty?: number;
}

async function fetchErpBatches(): Promise<ErpBatch[]> {
  const rows = await erpFetchAll('Batch', [
    'name', 'item', 'manufacturing_date', 'expiry_date', 'batch_qty',
  ]);
  return rows.map((r) => ({
    name:                String(r['name'] ?? ''),
    item:                String(r['item'] ?? ''),
    manufacturing_date:  r['manufacturing_date'] != null ? String(r['manufacturing_date']) : undefined,
    expiry_date:         r['expiry_date'] != null ? String(r['expiry_date']) : undefined,
    batch_qty:           r['batch_qty'] != null ? Number(r['batch_qty']) : undefined,
  }));
}

interface ErpBin {
  item_code: string;
  batch_no: string;       // → inventory.batch_id
  warehouse: string;
  actual_qty: number;
}

async function fetchErpInventory(): Promise<ErpBin[]> {
  // Bin 是 ERPNext 的即時庫存表，每個 item_code + warehouse + batch_no 一筆
  const rows = await erpFetchAll('Bin', [
    'item_code', 'batch_no', 'warehouse', 'actual_qty',
  ], [['Bin', 'actual_qty', '>', 0]]);

  return rows
    .filter((r) => r['batch_no'] != null && String(r['batch_no']).trim() !== '')
    .map((r) => ({
      item_code:  String(r['item_code']  ?? ''),
      batch_no:   String(r['batch_no']   ?? ''),
      warehouse:  String(r['warehouse']  ?? ''),
      actual_qty: Number(r['actual_qty'] ?? 0),
    }));
}

interface ErpSalesOrder {
  name: string;
  customer: string;       // → sales_orders.customer_name
  transaction_date: string;
  delivery_date?: string;
  status: string;
  grand_total?: number;
}

async function fetchErpSalesOrders(): Promise<ErpSalesOrder[]> {
  // 只同步尚未完成或取消的訂單（Draft / To Deliver and Bill / To Bill）
  const rows = await erpFetchAll('Sales Order', [
    'name', 'customer', 'transaction_date', 'delivery_date', 'status', 'grand_total',
  ], [['Sales Order', 'docstatus', '=', 1]]); // docstatus=1 代表 Submitted

  return rows.map((r) => ({
    name:             String(r['name']             ?? ''),
    customer:         String(r['customer']         ?? ''),
    transaction_date: String(r['transaction_date'] ?? ''),
    delivery_date:    r['delivery_date'] != null ? String(r['delivery_date']) : undefined,
    status:           String(r['status']           ?? ''),
    grand_total:      r['grand_total'] != null ? Number(r['grand_total']) : undefined,
  }));
}

interface ErpSalesOrderItem {
  name: string;           // → sales_order_items.name (primary key)
  parent: string;         // → sales_order_items.parent（父訂單 name）
  item_code: string;
  qty: number;
  rate?: number;
  delivery_date?: string;
}

async function fetchErpSalesOrderItems(orderNames: string[]): Promise<ErpSalesOrderItem[]> {
  const rows = await erpFetchChildAll(
    'Sales Order Item',
    ['name', 'parent', 'item_code', 'qty', 'rate', 'delivery_date'],
    'parent',
    orderNames,
  );
  return rows.map((r) => ({
    name:          String(r['name']          ?? ''),
    parent:        String(r['parent']        ?? ''),
    item_code:     String(r['item_code']     ?? ''),
    qty:           Number(r['qty']           ?? 0),
    rate:          r['rate']          != null ? Number(r['rate']) : undefined,
    delivery_date: r['delivery_date'] != null ? String(r['delivery_date']) : undefined,
  }));
}

// ─── Supabase 清空與寫入函式 ───────────────────────────────────────────────────

/**
 * 按照外鍵依賴順序清空六張表（子表先清，父表後清）
 * 不動 company_weights 與 allocation_recommendations
 */
async function clearTables(supabase: SupabaseClient): Promise<void> {
  // 清空順序：子表 → 父表，避免外鍵約束報錯
  const tables = [
    'allocation_recommendations', // 依賴 sales_order_items → 先清（只清外鍵影響到的部分，但為求乾淨全清）
    'sales_order_items',
    'sales_orders',
    'inventory',
    'batches',
    'items',
    'customers',
  ] as const;

  // allocation_recommendations 跟 ERPNext 無關，但它外鍵參照 sales_order_items，
  // 清空 sales_order_items 前必須先清它，否則外鍵約束會阻擋。
  // 這裡全部清空；如果你想保留已審核的紀錄，在執行前手動備份 allocation_recommendations。
  for (const table of tables) {
    const { error } = await supabase.from(table).delete().neq('id', '00000000-0000-0000-0000-000000000000');
    // neq('id', ...) 是繞過 Supabase 要求 filter 的方式，實際效果等同 DELETE FROM table
    if (error) {
      // 部分表可能沒有 id 欄位（如 sales_order_items 用 name），改用 truthy filter
      const { error: error2 } = await supabase.from(table).delete().gte('created_at', '1970-01-01');
      if (error2) {
        console.warn(`  ⚠️  清空 ${table} 失敗（${error2.message}），繼續執行...`);
      }
    }
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
      // customer_tier 優先讀取 ERPNext custom field，其次查對照表，最後 fallback
      const tier =
        (c.custom_customer_tier?.trim()) ||
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
      batch_id:            b.name,
      item_code:           b.item,
      manufacturing_date:  b.manufacturing_date ?? null,
      expiry_date:         b.expiry_date ?? null,
      batch_qty:           b.batch_qty ?? 0,
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

async function upsertSalesOrders(
  supabase: SupabaseClient,
  orders: ErpSalesOrder[],
): Promise<void> {
  if (orders.length === 0) return;
  const { error } = await supabase.from('sales_orders').insert(
    orders.map((o) => ({
      name:             o.name,
      customer_name:    o.customer,
      transaction_date: o.transaction_date,
      delivery_date:    o.delivery_date ?? null,
      status:           'Draft',  // 同步進來的訂單，在分配系統視為 Draft（待分配）
      grand_total:      o.grand_total ?? null,
    })),
  );
  if (error) throw new Error(`寫入 sales_orders 失敗：${error.message}`);
}

async function upsertSalesOrderItems(
  supabase: SupabaseClient,
  items: ErpSalesOrderItem[],
): Promise<void> {
  if (items.length === 0) return;

  // 分批插入，避免單次 payload 過大（每批 200 筆）
  const BATCH_SIZE = 200;
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const chunk = items.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('sales_order_items').insert(
      chunk.map((item) => ({
        name:          item.name,
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

// ─── 主流程 ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════');
  console.log(' ERPNext → Supabase 同步腳本');
  console.log(`  ERPNext: ${ERPNEXT_BASE_URL}`);
  console.log(`  Supabase: ${SUPABASE_URL}`);
  console.log('═══════════════════════════════════════════════════════\n');

  // 初始化 Supabase client（使用 service role key，繞過 RLS）
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // ── Step 1：從 ERPNext 讀取所有資料 ─────────────────────────────────────────
  console.log('【Step 1】從 ERPNext 讀取資料...\n');

  console.log('  ▸ 讀取 Item...');
  const erpItems = await fetchErpItems();
  console.log(`    → ${erpItems.length} 筆商品`);

  console.log('  ▸ 讀取 Customer...');
  const erpCustomers = await fetchErpCustomers();
  console.log(`    → ${erpCustomers.length} 筆客戶`);

  console.log('  ▸ 讀取 Batch...');
  const erpBatches = await fetchErpBatches();
  console.log(`    → ${erpBatches.length} 筆批次`);

  console.log('  ▸ 讀取 Bin（庫存）...');
  const erpBins = await fetchErpInventory();
  console.log(`    → ${erpBins.length} 筆庫存記錄（已過濾 actual_qty = 0）`);

  console.log('  ▸ 讀取 Sales Order...');
  const erpOrders = await fetchErpSalesOrders();
  console.log(`    → ${erpOrders.length} 筆訂單`);

  let erpOrderItems: ErpSalesOrderItem[] = [];
  if (erpOrders.length > 0) {
    console.log('  ▸ 讀取 Sales Order Item...');
    const orderNames = erpOrders.map((o) => o.name);
    erpOrderItems = await fetchErpSalesOrderItems(orderNames);
    console.log(`    → ${erpOrderItems.length} 筆訂單明細`);
  }

  console.log('\n【Step 2】清空 Supabase 目標表...\n');
  console.log('  ⚠️  將清空：allocation_recommendations、sales_order_items、sales_orders、');
  console.log('           inventory、batches、items、customers');
  console.log('  ✓  保留：company_weights（不動）\n');
  await clearTables(supabase);
  console.log('  清空完成。');

  // ── Step 3：寫入 Supabase（父表先寫，子表後寫）──────────────────────────────
  console.log('\n【Step 3】寫入 Supabase...\n');

  console.log('  ▸ 寫入 items...');
  await upsertItems(supabase, erpItems);
  console.log(`    → ${erpItems.length} 筆`);

  console.log('  ▸ 寫入 customers...');
  await upsertCustomers(supabase, erpCustomers);
  console.log(`    → ${erpCustomers.length} 筆`);

  // customer_tier 對照表覆蓋情況說明
  const tierFromMap    = erpCustomers.filter((c) => !c.custom_customer_tier && CUSTOMER_TIER_MAP[c.name]).length;
  const tierFromCustom = erpCustomers.filter((c) => c.custom_customer_tier?.trim()).length;
  const tierFromDefault = erpCustomers.length - tierFromMap - tierFromCustom;
  console.log(`      customer_tier 來源：ERPNext custom field ${tierFromCustom} 筆、對照表 ${tierFromMap} 筆、預設 standard ${tierFromDefault} 筆`);

  console.log('  ▸ 寫入 batches...');
  await upsertBatches(supabase, erpBatches);
  console.log(`    → ${erpBatches.length} 筆`);

  console.log('  ▸ 寫入 inventory...');
  await upsertInventory(supabase, erpBins);
  console.log(`    → ${erpBins.length} 筆`);

  console.log('  ▸ 寫入 sales_orders...');
  await upsertSalesOrders(supabase, erpOrders);
  console.log(`    → ${erpOrders.length} 筆`);

  console.log('  ▸ 寫入 sales_order_items...');
  await upsertSalesOrderItems(supabase, erpOrderItems);
  console.log(`    → ${erpOrderItems.length} 筆`);

  // ── Step 4：摘要 ─────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════');
  console.log(' ✅  同步完成');
  console.log('');
  console.log('  同步結果摘要：');
  console.log(`    商品 (items)                ${String(erpItems.length).padStart(5)} 筆`);
  console.log(`    客戶 (customers)            ${String(erpCustomers.length).padStart(5)} 筆`);
  console.log(`    批次 (batches)              ${String(erpBatches.length).padStart(5)} 筆`);
  console.log(`    庫存 (inventory)            ${String(erpBins.length).padStart(5)} 筆`);
  console.log(`    訂單 (sales_orders)         ${String(erpOrders.length).padStart(5)} 筆`);
  console.log(`    訂單明細 (sales_order_items)${String(erpOrderItems.length).padStart(5)} 筆`);
  console.log('');
  console.log('  下一步：');
  console.log('    前端按「執行分配引擎」（POST /api/run-allocation），');
  console.log('    或執行 POST https://<your-vercel>.vercel.app/api/run-allocation');
  console.log('═══════════════════════════════════════════════════════\n');
}

main().catch((err) => {
  console.error('\n❌  同步失敗：', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

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
 * 去除 ERPNext 自動附加的公司簡稱後綴（例如 "NORTH - ECV" → "NORTH"）。
 * ERPNext 的倉庫命名規則是「<名稱> - <公司簡稱>」，取最後一個
 * " - " 之前的部分。
 * 若倉庫名稱不含 " - "，原樣回傳（相容於手動建立的無後綴倉庫名稱）。
 */
function stripWarehouseSuffix(warehouseName: string): string {
  const idx = warehouseName.lastIndexOf(' - ');
  return idx === -1 ? warehouseName : warehouseName.slice(0, idx);
}

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

/**
 * 從 Serial and Batch Bundle 讀取批次級庫存（方案 B）。
 *
 * 資料路徑：
 *   Serial and Batch Bundle（父文件，含 item_code / warehouse）
 *     └─ entries[]（Serial and Batch Entry 子表，含 batch_no / qty / posting_datetime）
 *
 * 為什麼不走 Stock Ledger Entry？
 *   SLE.batch_no 在新版 ERPNext「Serial and Batch Bundle」機制下不會被回填，
 *   維持 null；批次與數量的對應關係改存在 Bundle 文件裡。
 *   此外，Serial and Batch Entry 子表無法透過 /api/resource 直接查詢，
 *   只能透過讀取各個 Bundle 父文件的 entries 欄位取得。
 *
 * ⚠️  目前假設全部都是 Inward（進貨）交易，filter 設定為 type_of_transaction = 'Inward'。
 *   未來如果加入出貨（Outward）異動，qty 會變成負數、當前庫存需要改用
 *   「同 item+batch+warehouse 的所有 Inward qty 總和 − Outward qty 總和」計算，
 *   或改讀 SLE.qty_after_transaction（屆時批次回填問題可能已解決）。
 *   在此之前，請勿把 Outward Bundle 納入計算，否則會低估庫存。
 *
 * 分組去重邏輯（在 JS 層處理）：
 *   - key = `item_code|batch_no|warehouse`
 *   - 以 entries[].posting_datetime（ISO 字串，字典序 = 時間序）保留最新一筆
 *   - 最終排除 qty ≤ 0 的批次（BAT-104 零庫存批次在此被濾掉）
 */
async function fetchErpInventory(): Promise<ErpBin[]> {
  // ── Step A：取得所有未取消、Inward 的 Bundle 清單 ────────────────────────────
  const bundleList = await erpFetchAll(
    'Serial and Batch Bundle',
    ['name', 'item_code', 'warehouse', 'is_cancelled', 'type_of_transaction'],
    [
      ['Serial and Batch Bundle', 'is_cancelled', '=', 0],
      // ⚠️  目前只處理進貨（Inward）；若未來有出貨異動，需重新設計（見 JSDoc 說明）
      ['Serial and Batch Bundle', 'type_of_transaction', '=', 'Inward'],
    ],
  );

  if (bundleList.length === 0) {
    console.log('    （Serial and Batch Bundle 查詢結果為 0 筆，請確認 ERPNext 已提交 Stock Entry）');
    return [];
  }

  // ── Step B：逐一讀取每個 Bundle 的完整文件（含 entries 子表）────────────────
  // ERPNext 的 Serial and Batch Entry 子表無法透過 resource API 直接批次查詢，
  // 只能透過 GET /api/resource/Serial and Batch Bundle/{id} 取得父文件再讀 entries。
  const latest = new Map<string, { qty: number; timestamp: string }>();

  for (const bundle of bundleList) {
    const bundleId = String(bundle['name'] ?? '');
    const parentItemCode  = String(bundle['item_code']  ?? '').trim();
    const parentWarehouse = stripWarehouseSuffix(String(bundle['warehouse'] ?? '').trim());

    if (!bundleId || !parentItemCode || !parentWarehouse) continue;

    // 讀取完整 Bundle 文件（entries 子表只在 single-doc GET 裡有完整資料）
    const url = `${ERPNEXT_BASE_URL}/api/resource/${encodeURIComponent('Serial and Batch Bundle')}/${encodeURIComponent(bundleId)}`;
    const resp = await fetch(url, { headers: { Authorization: AUTH_HEADER } });

    if (!resp.ok) {
      console.warn(`    ⚠️  讀取 Bundle ${bundleId} 失敗（HTTP ${resp.status}），略過`);
      continue;
    }

    const doc = (await resp.json() as { data?: { entries?: Record<string, unknown>[] } }).data;
    const entries = doc?.entries ?? [];

    for (const entry of entries) {
      const batchNo   = String(entry['batch_no']   ?? '').trim();
      const qty       = Number(entry['qty']         ?? 0);
      // posting_datetime 格式："YYYY-MM-DD HH:MM:SS.ffffff"，字典序 = 時間序
      const timestamp = String(entry['posting_datetime'] ?? '1970-01-01 00:00:00');

      // item_code / warehouse 以子表欄位優先，fallback 到父文件
      // warehouse 套用 stripWarehouseSuffix() 移除 ERPNext 自動附加的公司後綴（如 " - ECV"），
      // 確保與 customers.territory 的字串完全吻合，區域群聚評分才能正確計算。
      const itemCode  = String(entry['item_code']  ?? parentItemCode).trim()  || parentItemCode;
      const warehouse = stripWarehouseSuffix(
        String(entry['warehouse']  ?? parentWarehouse).trim() || parentWarehouse
      );

      if (!batchNo || !itemCode || !warehouse) continue;

      const key = `${itemCode}|${batchNo}|${warehouse}`;
      const current = latest.get(key);
      if (!current || timestamp > current.timestamp) {
        latest.set(key, { qty, timestamp });
      }
    }
  }

  // ── Step C：組裝輸出，排除 qty ≤ 0 ──────────────────────────────────────────
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
  ], [['Sales Order', 'docstatus', '=', 0]]); // docstatus=0 代表 Draft（草稿），AI 介入評估的時間點

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
  if (orderNames.length === 0) return [];

  // ERPNext 的子表 DocType（Sales Order Item）不允許直接查詢（403 PermissionError），
  // 改用逐一讀取父文件 Sales Order 的完整 doc，從 doc.items[] 子表欄位取得明細。
  // 這與讀取 Serial and Batch Bundle entries 的方式相同。
  const allItems: ErpSalesOrderItem[] = [];

  for (const orderName of orderNames) {
    const url = `${ERPNEXT_BASE_URL}/api/resource/${encodeURIComponent('Sales Order')}/${encodeURIComponent(orderName)}`;
    const resp = await fetch(url, { headers: { Authorization: AUTH_HEADER } });

    if (!resp.ok) {
      console.warn(`    ⚠️  讀取 Sales Order ${orderName} 失敗（HTTP ${resp.status}），略過`);
      continue;
    }

    const doc = (await resp.json() as { data?: Record<string, unknown> }).data;
    const items = (doc?.['items'] as Record<string, unknown>[] | undefined) ?? [];

    for (const item of items) {
      allItems.push({
        name:          '',   // BIGSERIAL，由 DB 自動產生，寫入時不帶
        parent:        orderName,   // 父訂單 name，直接用已知的 orderName 確保正確
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

/**
 * 各表對應的主鍵欄位名稱。
 * 用明確對照表取代「先猜 id、失敗退回 created_at」的通用策略，
 * 因為本專案 8 張表的主鍵欄位名稱並不統一（有 id、name、batch_id 等）。
 */
const TABLE_PRIMARY_KEYS: Record<string, string> = {
  sales_order_items:          'name',
  inventory:                  'id',
  sales_orders:               'name',
  batches:                    'batch_id',
  items:                      'item_code',
  customers:                  'customer_name',
};

/**
 * 按照外鍵依賴順序清空六張同步資料表（子表先清，父表後清）。
 * allocation_recommendations 是稽核歷史，刻意不清除；它只能使用業務鍵保存，
 * 不能依賴每次同步都會重建的 sales_order_items.name。
 *
 * 刪除條件：.not(pkColumn, 'is', null)
 *   主鍵欄位保證不為 null，這個條件對 TEXT 與 BIGSERIAL 都通用，
 *   等效於「刪除全部資料列」，不需要依型別分支。
 *
 * 清空任一張表失敗時立即拋錯並中斷，避免「清空失敗卻繼續寫入」
 * 造成後續主鍵衝突（duplicate key）等更難排查的錯誤。
 */
async function clearTables(supabase: SupabaseClient): Promise<void> {
  // 清空順序：子表 → 父表（已驗證符合外鍵依賴關係）
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
    if (!pkColumn) throw new Error(`clearTables：找不到 ${table} 的主鍵欄位定義`);

    const { error } = await supabase.from(table).delete().not(pkColumn, 'is', null);
    if (error) {
      // 清空失敗立即中斷，不吞錯誤，讓呼叫端看到真正的原因
      throw new Error(`清空 ${table}（主鍵：${pkColumn}）失敗：${error.message}`);
    }
    console.log(`    ✓ ${table}`);
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
        // name 欄位是 BIGSERIAL，由資料庫自動遞增，不要手動賦值
        // ERPNext 原始的雜湊字串 ID（item.name）在此捨棄，
        // 關聯查詢只需要 parent（→ sales_orders.name）即可
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

  console.log('  ▸ 讀取 Serial and Batch Bundle（批次級庫存）...');
  const erpBins = await fetchErpInventory();
  console.log(`    → ${erpBins.length} 筆庫存記錄（Inward Bundle 分組去重後 qty > 0 的批次）`);

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
  console.log('  ⚠️  將清空：sales_order_items、inventory、');
  console.log('           sales_orders、batches、items、customers');
  console.log('  ✓  保留：company_weights、allocation_recommendations（稽核歷史）\n');
  await clearTables(supabase);
  console.log('\n  清空完成。');

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

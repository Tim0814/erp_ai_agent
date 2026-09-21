import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseKey);

    // 不使用 PostgREST 關聯嵌入：稽核表刻意不依賴會隨同步重建的外鍵。
    const { data, error } = await supabase
      .from('allocation_recommendations')
      .select('sales_order, recommended_qty, item_code, batch_id, warehouse, score, traffic_light, status, reviewed_at')
      .eq('status', 'approved')
      .order('reviewed_at', { ascending: false });

    if (error) throw error;

    const records = data ?? [];
    const salesOrderNames = [...new Set(records.map((record: any) => record.sales_order).filter(Boolean))];
    const itemCodes = [...new Set(records.map((record: any) => record.item_code).filter(Boolean))];

    const [{ data: salesOrders, error: salesOrdersError }, { data: items, error: itemsError }] =
      await Promise.all([
        salesOrderNames.length === 0
          ? Promise.resolve({ data: [], error: null })
          : supabase.from('sales_orders').select('name, customer_name').in('name', salesOrderNames),
        itemCodes.length === 0
          ? Promise.resolve({ data: [], error: null })
          : supabase.from('items').select('item_code, item_name').in('item_code', itemCodes),
      ]);

    if (salesOrdersError) throw salesOrdersError;
    if (itemsError) throw itemsError;

    const customerNames = new Map((salesOrders ?? []).map((order: any) => [order.name, order.customer_name]));
    const itemNames = new Map((items ?? []).map((item: any) => [item.item_code, item.item_name]));

    // CSV 欄位跳脫：雙引號包覆，內部雙引號轉義
    const escape = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

    const HEADERS = [
      '訂單編號',
      '客戶名稱',
      '商品名稱',
      '商品代碼',
      '建議數量',
      '建議批次',
      '倉庫',
      '加權總分',
      '燈號',
      '審核狀態',
      '核准時間',
    ];
    const header = HEADERS.map(escape).join(',');

    const rows = records.map((r: any) => {
      const customerName = customerNames.get(r.sales_order) ?? '';
      const itemName = itemNames.get(r.item_code) ?? '';
      return [
        r.sales_order ?? '',
        customerName,
        itemName,
        r.item_code ?? '',
        r.recommended_qty ?? 0,
        r.batch_id ?? '',
        r.warehouse ?? '',
        r.score ?? 0,
        r.traffic_light ?? '',
        r.status ?? '',
        r.reviewed_at ?? '',
      ].map(escape).join(',');
    });

    const csv = [header, ...rows].join('\r\n');

    // 檔名使用 ASCII（YYYYMMDD），避開中文檔名下載編碼問題
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const filename = `allocation_recommendations_${today}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8-sig');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // BOM (\uFEFF) 讓 Excel 正確識別 UTF-8 中文
    return res.status(200).send('\uFEFF' + csv);
  } catch (error) {
    console.error('CSV export error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

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

    // 查詢 approved 紀錄，JOIN sales_orders 取客戶名稱、JOIN items 取商品名稱
    const { data, error } = await supabase
      .from('allocation_recommendations')
      .select(`
        recommended_qty,
        item_code,
        batch_id,
        warehouse,
        score,
        reviewed_at,
        sales_orders!sales_order ( customer_name ),
        items!item_code ( item_name )
      `)
      .eq('status', 'approved')
      .order('reviewed_at', { ascending: false });

    if (error) throw error;

    const records = data ?? [];

    // CSV 欄位跳脫：雙引號包覆，內部雙引號轉義
    const escape = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

    const HEADERS = ['客戶名稱', '商品名稱', '商品代碼', '分配數量', '建議批次', '倉庫', '加權總分', '核准時間'];
    const header = HEADERS.map(escape).join(',');

    const rows = records.map((r: any) => {
      const customerName = r.sales_orders?.customer_name ?? '';
      const itemName = r.items?.item_name ?? '';
      return [
        customerName,
        itemName,
        r.item_code ?? '',
        r.recommended_qty ?? 0,
        r.batch_id ?? '',
        r.warehouse ?? '',
        r.score ?? 0,
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

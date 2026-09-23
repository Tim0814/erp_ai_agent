import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return res.status(200).json({ success: true, data: [] });
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Step 1：取得所有分配建議
    const { data: recs, error: recError } = await supabase
      .from('allocation_recommendations')
      .select('*')
      .order('created_at', { ascending: false });

    if (recError) throw recError;
    if (!recs || recs.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }

    // Step 2：收集去重的 sales_order 編號，查詢對應的 created_by
    const orderNames = [...new Set(recs.map((r) => r.sales_order as string).filter(Boolean))];

    const { data: orders, error: orderError } = await supabase
      .from('sales_orders')
      .select('name, created_by')
      .in('name', orderNames);

    if (orderError) throw orderError;

    // 建立 sales_order name → created_by 的查找 Map
    const createdByMap = new Map<string, string | null>(
      (orders ?? []).map((o) => [o.name as string, (o.created_by as string | null) ?? null]),
    );

    // Step 3：將 created_by 攤平到每筆建議，命名為 order_created_by
    const flatData = recs.map((rec) => ({
      ...rec,
      order_created_by: createdByMap.get(rec.sales_order as string) ?? null,
    }));

    return res.status(200).json({ success: true, data: flatData });
  } catch (error) {
    console.error('Get recommendations error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

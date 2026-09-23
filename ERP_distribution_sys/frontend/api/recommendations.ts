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
    const { data, error } = await supabase
      .from('allocation_recommendations')
      .select(`
        *,
        sales_orders!inner(created_by)
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // 將 JOIN 進來的 sales_orders.created_by 攤平到頂層，命名為 order_created_by
    const flatData = (data ?? []).map((row: Record<string, unknown>) => {
      const soRow = row['sales_orders'] as { created_by?: string | null } | null;
      const { sales_orders: _so, ...rest } = row;
      return {
        ...rest,
        order_created_by: soRow?.created_by ?? null,
      };
    });

    return res.status(200).json({ success: true, data: flatData });
  } catch (error) {
    console.error('Get recommendations error:', error);
    return res.status(500).json({ error: 'Internal server error', details: error instanceof Error ? error.message : String(error) });
  }
}

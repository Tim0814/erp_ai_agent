import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { name } = req.query;
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Invalid sales order name' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseKey);
    const { data: order, error: orderError } = await supabase
      .from('sales_orders')
      .select('name, status')
      .eq('name', name)
      .maybeSingle();

    if (orderError) throw orderError;
    if (!order) return res.status(404).json({ error: `Sales order not found: ${name}` });
    if (order.status === 'Cancelled') {
      return res.status(409).json({ error: `Sales order is already cancelled: ${name}` });
    }

    const { error: cancelOrderError } = await supabase
      .from('sales_orders')
      .update({ status: 'Cancelled' })
      .eq('name', name);
    if (cancelOrderError) throw cancelOrderError;

    // 保留歷史建議，只將原本仍會占用批次的紀錄標為失效。
    const { data: activeRecommendations, error: recommendationsError } = await supabase
      .from('allocation_recommendations')
      .select('id, batch_id')
      .eq('sales_order', name)
      .not('status', 'in', '("cancelled","rejected")');
    if (recommendationsError) throw recommendationsError;

    const recommendationIds = (activeRecommendations ?? []).map((rec: any) => rec.id);
    if (recommendationIds.length > 0) {
      const { error: cancelRecommendationsError } = await supabase
        .from('allocation_recommendations')
        .update({ status: 'cancelled' })
        .in('id', recommendationIds);
      if (cancelRecommendationsError) throw cancelRecommendationsError;
    }

    const releasedBatchIds = [...new Set(
      (activeRecommendations ?? [])
        .map((rec: any) => rec.batch_id)
        .filter((batchId: unknown): batchId is string => typeof batchId === 'string' && batchId.length > 0),
    )];

    return res.status(200).json({
      success: true,
      sales_order: name,
      released_batch_ids: releasedBatchIds,
    });
  } catch (error) {
    console.error('Cancel sales order error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

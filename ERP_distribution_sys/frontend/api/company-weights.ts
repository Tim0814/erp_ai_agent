import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

// 允許讀寫的 enabled 欄位白名單，防止任意欄位注入
const ENABLED_FIELDS = [
  'fefo_enabled',
  'urgency_enabled',
  'order_time_enabled',
  'customer_tier_enabled',
  'region_enabled',
] as const;

type EnabledField = (typeof ENABLED_FIELDS)[number];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  // ── GET：讀取目前的 enabled 狀態 ────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('company_weights')
        .select('fefo_enabled, urgency_enabled, order_time_enabled, customer_tier_enabled, region_enabled')
        .eq('profile_name', 'default')
        .maybeSingle();

      if (error) throw error;

      if (!data) {
        return res.status(404).json({ error: 'company_weights default profile not found' });
      }

      return res.status(200).json({ success: true, data });
    } catch (error) {
      console.error('GET company-weights error:', error);
      return res.status(500).json({
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── PATCH：更新單一 enabled 欄位 ────────────────────────────────────────────
  if (req.method === 'PATCH') {
    try {
      const body = req.body as { field?: string; value?: boolean };

      if (!body || typeof body.field !== 'string' || typeof body.value !== 'boolean') {
        return res.status(400).json({ error: 'Body must contain { field: string, value: boolean }' });
      }

      const field = body.field as EnabledField;
      if (!ENABLED_FIELDS.includes(field)) {
        return res.status(400).json({
          error: `Invalid field. Must be one of: ${ENABLED_FIELDS.join(', ')}`,
        });
      }

      const { data, error } = await supabase
        .from('company_weights')
        .update({ [field]: body.value })
        .eq('profile_name', 'default')
        .select('fefo_enabled, urgency_enabled, order_time_enabled, customer_tier_enabled, region_enabled')
        .maybeSingle();

      if (error) throw error;

      return res.status(200).json({ success: true, data });
    } catch (error) {
      console.error('PATCH company-weights error:', error);
      return res.status(500).json({
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

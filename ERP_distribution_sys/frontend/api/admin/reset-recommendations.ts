import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // service role key 走後端環境變數，不走任何 VITE_ 前綴，不會進前端 bundle
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return res.status(503).json({
      error: 'Admin client not configured',
      details: 'SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY 未設定',
    });
  }

  // 以 service role key 建 client，繞過 RLS，讓 TRUNCATE 能執行
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const { data, error } = await supabase.rpc('reset_allocation_recommendations');

  if (error) {
    console.error('[admin] reset_allocation_recommendations RPC 失敗：', error.message);
    return res.status(500).json({
      error: 'RPC failed',
      details: error.message,
    });
  }

  // RPC 回傳刪除前的筆數（integer）
  const deletedCount = typeof data === 'number' ? data : 0;
  console.log(`[admin] allocation_recommendations 已清空，刪除 ${deletedCount} 筆`);

  return res.status(200).json({ success: true, deleted_count: deletedCount });
}

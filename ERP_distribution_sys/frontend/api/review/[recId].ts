import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

/**
 * 從請求的 Authorization header 解析 Bearer token，
 * 並用 Supabase service role 驗證取得登入者 email。
 *
 * 過渡期安全網：token 缺失或驗證失敗時回傳 'operator'（不擋請求），
 * 並印出警告 log。等系統穩定後可改成回傳 null 並在呼叫端擋下請求。
 */
async function resolveOperatorEmail(req: VercelRequest): Promise<string> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const authHeader = req.headers['authorization'];
  const token = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  if (!token) {
    console.warn('[review] Authorization header 缺失，fallback 到 operator');
    return 'operator';
  }

  if (!supabaseUrl || !serviceRoleKey) {
    console.warn('[review] SUPABASE_SERVICE_ROLE_KEY 未設定，無法驗證 token，fallback 到 operator');
    return 'operator';
  }

  try {
    // 用 service role client 驗證 token（不受 RLS 限制）
    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });
    const { data: { user }, error } = await adminClient.auth.getUser(token);

    if (error || !user?.email) {
      console.warn('[review] token 驗證失敗，fallback 到 operator:', error?.message ?? '無 email');
      return 'operator';
    }

    return user.email;
  } catch (err) {
    console.warn('[review] token 驗證例外，fallback 到 operator:', err);
    return 'operator';
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { recId } = req.query;
  if (!recId || typeof recId !== 'string') {
    return res.status(400).json({ error: 'Invalid recommendation ID' });
  }

  const { action, override_reason } = req.body ?? {};

  // 前端送來的合法動作值
  const validActions = ['approved', 'overridden', 'rejected'];
  if (!action || !validActions.includes(action)) {
    return res.status(400).json({ error: `Invalid action. Must be one of: ${validActions.join(', ')}` });
  }
  if (action === 'overridden' && (typeof override_reason !== 'string' || !override_reason.trim())) {
    return res.status(400).json({ error: '覆寫 (overridden) 時必須填寫覆寫原因 (override_reason)' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  try {
    // 解析操作者身分（token 驗證失敗時 fallback 到 'operator'，不擋請求）
    const operatorEmail = await resolveOperatorEmail(req);

    const supabase = createClient(supabaseUrl, supabaseKey);
    const now = new Date().toISOString();

    // action → status 對應：
    //   'approved'  → status: 'approved'
    //   'overridden'→ status: 'approved' + is_overridden: true（業務語意：覆寫後核准）
    //   'rejected'  → status: 'rejected'
    const newStatus: 'approved' | 'rejected' =
      action === 'rejected' ? 'rejected' : 'approved';

    const isOverridden = action === 'overridden';

    const updatePayload: Record<string, unknown> = {
      status: newStatus,
      reviewed_by: operatorEmail,
      reviewed_at: now,
      // 覆寫相關欄位
      is_overridden: isOverridden,
      override_reason: isOverridden ? override_reason.trim() : null,
      overridden_by: isOverridden ? operatorEmail : null,
      overridden_at: isOverridden ? now : null,
    };

    const { data, error } = await supabase
      .from('allocation_recommendations')
      .update(updatePayload)
      .eq('id', recId)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: `找不到指定的分配紀錄: ${recId}` });

    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error('Review error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

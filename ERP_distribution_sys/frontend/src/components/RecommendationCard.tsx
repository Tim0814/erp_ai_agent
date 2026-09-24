import React from 'react';
import { Recommendation, ReviewAction } from '../types';
import { CheckCircle2, Edit3, XCircle, AlertTriangle, Ban } from 'lucide-react';

interface RecommendationCardProps {
  rec: Recommendation;
  onApprove: (id: string) => void;
  onOverride: (rec: Recommendation) => void;
  onReject: (id: string) => void;
  onCancel: (salesOrder: string) => void;
}

// ── 日期格式化：YYYY-MM-DD HH:mm ────────────────────────────────────────────
function formatDatetime(value: string | null | undefined): string {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

// ── 需求 A：審核狀態徽章設定 ─────────────────────────────────────────────────
interface ReviewBadgeConfig {
  label: string;
  color: string;
  bg: string;
  border: string;
}

function getReviewBadge(
  status: Recommendation['status'],
  isOverridden: boolean,
): ReviewBadgeConfig | null {
  if (status === 'approved' && !isOverridden) {
    return { label: '✅ 已核准', color: '#10b981', bg: 'rgba(16,185,129,0.15)', border: 'rgba(16,185,129,0.35)' };
  }
  if (status === 'approved' && isOverridden) {
    return { label: '🔄 已覆寫核准', color: '#60a5fa', bg: 'rgba(96,165,250,0.15)', border: 'rgba(96,165,250,0.35)' };
  }
  if (status === 'rejected') {
    return { label: '❌ 已退回', color: '#94a3b8', bg: 'rgba(148,163,184,0.12)', border: 'rgba(148,163,184,0.25)' };
  }
  return null; // pending：不顯示
}

// ── 需求 C：審核歷程一行文字 ─────────────────────────────────────────────────
function getAuditLine(rec: Recommendation): string | null {
  if (rec.status === 'approved' && !rec.is_overridden) {
    const by = rec.reviewed_by || '—';
    const at = formatDatetime(rec.reviewed_at);
    return `由 ${by} 於 ${at} 核准`;
  }
  if (rec.status === 'approved' && rec.is_overridden) {
    const by = rec.overridden_by || '—';
    const at = formatDatetime(rec.overridden_at);
    const reason = rec.override_reason || '未填寫';
    return `由 ${by} 於 ${at} 覆寫核准，原因：${reason}`;
  }
  if (rec.status === 'rejected') {
    const by = rec.reviewed_by || '—';
    const at = formatDatetime(rec.reviewed_at);
    return `由 ${by} 於 ${at} 退回`;
  }
  return null;
}

// ── 需求 B：五維度長條圖資料 ─────────────────────────────────────────────────
const SCORE_BARS = [
  { label: '先效期先出', key: 'fefo_score' },
  { label: '緊急度',     key: 'urgency_score' },
  { label: '下單時間',   key: 'order_time_score' },
  { label: '客戶等級',   key: 'customer_tier_score' },
  { label: '區域群聚',   key: 'region_score' },
] as const;

export const RecommendationCard: React.FC<RecommendationCardProps> = ({
  rec,
  onApprove,
  onOverride,
  onReject,
  onCancel,
}) => {
  // 依 traffic_light 決定卡片配色與標籤，與審核流程 status 完全獨立
  const getStatusTheme = () => {
    if (rec.traffic_light === 'red') {
      return { cardClass: 'status-red', badgeClass: 'badge-red', label: '阻斷 / 人工處理' };
    }
    if (rec.traffic_light === 'green') {
      return { cardClass: 'status-green', badgeClass: 'badge-green', label: '可直接確認' };
    }
    return { cardClass: 'status-orange', badgeClass: 'badge-orange', label: '建議複核' };
  };

  const theme = getStatusTheme();

  // 需求 A：status !== 'pending' 時，三個審核按鈕 disabled
  const isReviewed = rec.status !== 'pending';
  const reviewBadge = getReviewBadge(rec.status, rec.is_overridden);
  const auditLine = getAuditLine(rec);

  return (
    <div className={`card ${theme.cardClass}`}>
      <div>
        {/* 卡片頂部：訂單編號 + 商品代碼 + 總分 + 審核狀態徽章（需求 A） */}
        <div className="card-header">
          <div>
            <div className="order-id">
              {rec.sales_order}
              <span style={{ marginLeft: '0.5rem', fontSize: '0.75rem', color: '#94a3b8' }}>
                #{rec.item_code}
              </span>
            </div>
            {rec.order_created_by && (
              <span style={{ fontSize: '0.72rem', color: '#64748b', display: 'block', marginTop: '0.1rem' }}>
                建立者：{rec.order_created_by}
              </span>
            )}
            <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
              總分：
              <strong style={{ color: '#ffffff', fontSize: '0.9rem' }}>
                {Number(rec.score).toFixed(1)}
              </strong>
            </span>
          </div>

          {/* 右上角：traffic_light 燈號徽章 + 審核狀態徽章（堆疊排列） */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.35rem' }}>
            <span className={`badge ${theme.badgeClass}`}>{theme.label}</span>
            {reviewBadge && (
              <span
                style={{
                  fontSize: '0.72rem',
                  fontWeight: 700,
                  padding: '0.2rem 0.55rem',
                  borderRadius: '5px',
                  color: reviewBadge.color,
                  background: reviewBadge.bg,
                  border: `1px solid ${reviewBadge.border}`,
                  whiteSpace: 'nowrap',
                }}
              >
                {reviewBadge.label}
              </span>
            )}
          </div>
        </div>

        {/* 批次資訊 / 紅燈原因 */}
        <div className="batch-info">
          {rec.traffic_light === 'red' ? (
            <div style={{ color: '#ef4444', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <AlertTriangle size={16} />
              <strong>燈號原因：</strong>
              {rec.traffic_light_reason || '無可分配批次'}
            </div>
          ) : (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                建議批次：<span>{rec.batch_id}</span>
              </div>
              <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
                倉庫：<strong style={{ color: '#10b981' }}>{rec.warehouse}</strong>
              </div>
            </div>
          )}
        </div>

        {/* 需求 B：五維度橫向長條圖（取代原本的 score-breakdown-grid pill） */}
        <div style={{ marginBottom: '1rem' }}>
          {SCORE_BARS.map(({ label, key }) => {
            const val = Math.min(100, Math.max(0, Number(rec[key])));
            return (
              <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem' }}>
                {/* 中文標籤，固定寬度對齊 */}
                <span
                  style={{
                    fontSize: '0.72rem',
                    color: '#64748b',
                    width: '5.2rem',
                    flexShrink: 0,
                    textAlign: 'right',
                  }}
                >
                  {label}
                </span>
                {/* 長條軌道 */}
                <div
                  style={{
                    flex: 1,
                    height: '6px',
                    background: 'rgba(255,255,255,0.07)',
                    borderRadius: '3px',
                    overflow: 'hidden',
                  }}
                >
                  {/* 長條填色：以 #38bdf8 統一主色 */}
                  <div
                    style={{
                      width: `${val}%`,
                      height: '100%',
                      background: '#38bdf8',
                      borderRadius: '3px',
                      transition: 'width 0.3s ease',
                    }}
                  />
                </div>
                {/* 數字分數 */}
                <span
                  style={{
                    fontSize: '0.72rem',
                    fontWeight: 700,
                    color: '#e2e8f0',
                    width: '2rem',
                    textAlign: 'right',
                    flexShrink: 0,
                  }}
                >
                  {val.toFixed(0)}
                </span>
              </div>
            );
          })}
        </div>

        {/* AI 說明文字 */}
        <div className="ai-explanation">
          💡 <strong>AI 說明：</strong> {rec.rationale || '系統評估完成'}
        </div>

        {/* 需求 C：審核歷程一行灰色小字（status !== 'pending' 才顯示） */}
        {auditLine && (
          <div
            style={{
              fontSize: '0.72rem',
              color: '#475569',
              marginBottom: '0.75rem',
              lineHeight: 1.4,
            }}
          >
            {auditLine}
          </div>
        )}
      </div>

      {/* 操作按鈕
          需求 A：status !== 'pending' 時核准／覆寫／退回三個按鈕 disabled
          棄單按鈕不受此限制，維持原本邏輯
          紅燈時核准按鈕額外 disabled（原有邏輯保留）
      */}
      <div className="card-actions">
        <button
          className="btn btn-sm btn-approve"
          onClick={() => onApprove(rec.id)}
          disabled={isReviewed || rec.traffic_light === 'red'}
          title={
            isReviewed
              ? '此建議已完成審核，無法重複操作'
              : rec.traffic_light === 'red'
              ? '紅燈案例不可直接核准，請覆寫或退回'
              : undefined
          }
        >
          <CheckCircle2 size={14} /> 核准
        </button>
        <button
          className="btn btn-sm btn-override"
          onClick={() => onOverride(rec)}
          disabled={isReviewed}
          title={isReviewed ? '此建議已完成審核，無法重複操作' : undefined}
        >
          <Edit3 size={14} /> 覆寫
        </button>
        <button
          className="btn btn-sm btn-reject"
          onClick={() => onReject(rec.id)}
          disabled={isReviewed}
          title={isReviewed ? '此建議已完成審核，無法重複操作' : undefined}
        >
          <XCircle size={14} /> 退回
        </button>
        {rec.status !== 'cancelled' && (
          <button className="btn btn-sm btn-secondary" onClick={() => onCancel(rec.sales_order)}>
            <Ban size={14} /> 棄單
          </button>
        )}
      </div>
    </div>
  );
};

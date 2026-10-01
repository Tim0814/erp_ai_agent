import React, { useState } from 'react';
import {
  Radar, RadarChart, PolarGrid, PolarAngleAxis, ResponsiveContainer, Tooltip,
} from 'recharts';
import { Recommendation } from '../types';
import { CheckCircle2, Edit3, XCircle, AlertTriangle, Ban, BarChart2, ArrowLeft } from 'lucide-react';

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

// ── 審核狀態徽章設定 ─────────────────────────────────────────────────────────
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
    return { label: '✏️ 已覆寫核准', color: '#f59e0b', bg: 'rgba(245,158,11,0.18)', border: 'rgba(245,158,11,0.5)' };
  }
  if (status === 'rejected') {
    return { label: '❌ 已退回', color: '#94a3b8', bg: 'rgba(148,163,184,0.12)', border: 'rgba(148,163,184,0.25)' };
  }
  return null;
}

// ── 五維度長條圖資料 ─────────────────────────────────────────────────────────
const SCORE_BARS = [
  { label: '先效期先出', key: 'fefo_score' },
  { label: '緊急度',     key: 'urgency_score' },
  { label: '下單時間',   key: 'order_time_score' },
  { label: '客戶等級',   key: 'customer_tier_score' },
  { label: '區域群聚',   key: 'region_score' },
] as const;

// ── recharts 自訂 Tooltip ────────────────────────────────────────────────────
const RadarTooltip = ({ active, payload }: any) => {
  if (!active || !payload?.length) return null;
  const { subject, value } = payload[0].payload;
  return (
    <div style={{
      background: 'rgba(15,23,42,0.95)',
      border: '1px solid rgba(255,255,255,0.12)',
      borderRadius: '6px',
      padding: '0.4rem 0.7rem',
      fontSize: '0.8rem',
      color: '#e2e8f0',
    }}>
      <strong style={{ color: '#38bdf8' }}>{subject}</strong>：{Number(value).toFixed(1)}
    </div>
  );
};

export const RecommendationCard: React.FC<RecommendationCardProps> = ({
  rec,
  onApprove,
  onOverride,
  onReject,
  onCancel,
}) => {
  const [flipped, setFlipped] = useState(false);

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
  const isReviewed = rec.status !== 'pending';
  const reviewBadge = getReviewBadge(rec.status, rec.is_overridden);

  // 雷達圖資料
  const radarData = [
    { subject: '先效期先出', value: Number(rec.fefo_score)          ?? 0 },
    { subject: '緊急度',     value: Number(rec.urgency_score)       ?? 0 },
    { subject: '下單時間',   value: Number(rec.order_time_score)    ?? 0 },
    { subject: '客戶等級',   value: Number(rec.customer_tier_score) ?? 0 },
    { subject: '區域群聚',   value: Number(rec.region_score)        ?? 0 },
  ];

  // 一般核准 / 退回的審核小字
  const auditLine = (() => {
    if (rec.status === 'approved' && !rec.is_overridden)
      return `由 ${rec.reviewed_by || '—'} 於 ${formatDatetime(rec.reviewed_at)} 核准`;
    if (rec.status === 'rejected')
      return `由 ${rec.reviewed_by || '—'} 於 ${formatDatetime(rec.reviewed_at)} 退回`;
    return null;
  })();

  return (
    /* 外層容器：固定高度 + perspective，讓 3D 翻轉有透視感 */
    <div
      className={`card-flip-wrapper ${flipped ? 'is-flipped' : ''}`}
      style={{ perspective: '1000px' }}
    >
      <div className="card-flip-inner">

        {/* ═══════════════════════════════ 正面 ═══════════════════════════════ */}
        <div className={`card ${theme.cardClass} card-face card-front`}>
          <div>
            {/* 頂部：訂單 + 商品 + 總分 + 徽章 */}
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

              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.35rem' }}>
                <span className={`badge ${theme.badgeClass}`}>{theme.label}</span>
                {reviewBadge && (
                  <span style={{
                    fontSize: '0.72rem', fontWeight: 700,
                    padding: '0.2rem 0.55rem', borderRadius: '5px',
                    color: reviewBadge.color, background: reviewBadge.bg,
                    border: `1px solid ${reviewBadge.border}`, whiteSpace: 'nowrap',
                  }}>
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
                  <div>建議批次：<span>{rec.batch_id}</span></div>
                  <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
                    倉庫：<strong style={{ color: '#10b981' }}>{rec.warehouse}</strong>
                  </div>
                </div>
              )}
            </div>

            {/* 五維度橫向長條圖 */}
            <div style={{ marginBottom: '1rem' }}>
              {SCORE_BARS.map(({ label, key }) => {
                const val = Math.min(100, Math.max(0, Number(rec[key])));
                return (
                  <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem' }}>
                    <span style={{ fontSize: '0.72rem', color: '#64748b', width: '5.2rem', flexShrink: 0, textAlign: 'right' }}>
                      {label}
                    </span>
                    <div style={{ flex: 1, height: '6px', background: 'rgba(255,255,255,0.07)', borderRadius: '3px', overflow: 'hidden' }}>
                      <div style={{ width: `${val}%`, height: '100%', background: '#38bdf8', borderRadius: '3px', transition: 'width 0.3s ease' }} />
                    </div>
                    <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#e2e8f0', width: '2rem', textAlign: 'right', flexShrink: 0 }}>
                      {val.toFixed(0)}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* AI 說明 */}
            <div className="ai-explanation">
              💡 <strong>AI 說明：</strong> {rec.rationale || '系統評估完成'}
            </div>

            {/* 覆寫訊息色塊 */}
            {rec.status === 'approved' && rec.is_overridden ? (
              <div style={{
                display: 'flex', flexDirection: 'column', gap: '0.3rem',
                background: 'rgba(245,158,11,0.12)',
                border: '1px solid rgba(245,158,11,0.45)',
                borderLeft: '3px solid #f59e0b',
                borderRadius: '6px', padding: '0.55rem 0.75rem', marginBottom: '0.75rem',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <Edit3 size={13} color="#f59e0b" style={{ flexShrink: 0 }} />
                  <span style={{ fontSize: '0.78rem', fontWeight: 700, color: '#f59e0b' }}>人工覆寫核准</span>
                  <span style={{ fontSize: '0.72rem', color: '#fbbf24', marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                    {rec.overridden_by || '—'} · {formatDatetime(rec.overridden_at)}
                  </span>
                </div>
                <p style={{ fontSize: '0.82rem', color: '#fef3c7', margin: 0, lineHeight: 1.5, wordBreak: 'break-all' }}>
                  原因：{rec.override_reason || '（未填寫）'}
                </p>
              </div>
            ) : (
              auditLine && (
                <div style={{ fontSize: '0.72rem', color: '#475569', marginBottom: '0.75rem', lineHeight: 1.4 }}>
                  {auditLine}
                </div>
              )
            )}
          </div>

          {/* 操作按鈕列 */}
          <div className="card-actions">
            <button
              className="btn btn-sm btn-approve"
              onClick={() => onApprove(rec.id)}
              disabled={isReviewed || rec.traffic_light === 'red'}
              title={isReviewed ? '此建議已完成審核，無法重複操作' : rec.traffic_light === 'red' ? '紅燈案例不可直接核准，請覆寫或退回' : undefined}
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
            {/* 查看詳情按鈕：翻至雷達圖背面 */}
            <button
              className="btn btn-sm btn-detail"
              onClick={() => setFlipped(true)}
              title="查看五維度雷達圖"
            >
              <BarChart2 size={14} /> 詳情
            </button>
          </div>
        </div>

        {/* ═══════════════════════════════ 背面 ═══════════════════════════════ */}
        <div className={`card ${theme.cardClass} card-face card-back`}>
          {/* 背面頂部：標題 + 返回按鈕 */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <div>
              <div style={{ fontSize: '0.9rem', fontWeight: 700, color: '#fff' }}>
                {rec.sales_order}
                <span style={{ marginLeft: '0.4rem', fontSize: '0.72rem', color: '#94a3b8' }}>#{rec.item_code}</span>
              </div>
              <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '0.1rem' }}>
                五維度綜合評分雷達圖
              </div>
            </div>
            <button
              className="btn btn-sm btn-secondary"
              onClick={() => setFlipped(false)}
              title="返回"
              style={{ flexShrink: 0 }}
            >
              <ArrowLeft size={14} /> 返回
            </button>
          </div>

          {/* 雷達圖 */}
          <div style={{ flex: 1, minHeight: 0 }}>
            <ResponsiveContainer width="100%" height={240}>
              <RadarChart data={radarData} margin={{ top: 10, right: 20, bottom: 10, left: 20 }}>
                <PolarGrid stroke="rgba(255,255,255,0.1)" />
                <PolarAngleAxis
                  dataKey="subject"
                  tick={{ fill: '#94a3b8', fontSize: 11 }}
                />
                <Radar
                  name="分數"
                  dataKey="value"
                  stroke="#38bdf8"
                  fill="#38bdf8"
                  fillOpacity={0.25}
                  dot={{ r: 3, fill: '#38bdf8', strokeWidth: 0 }}
                />
                <Tooltip content={<RadarTooltip />} />
              </RadarChart>
            </ResponsiveContainer>
          </div>

          {/* 背面底部：五維度數字摘要 */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(5, 1fr)',
            gap: '0.4rem',
            marginTop: '0.5rem',
          }}>
            {radarData.map(({ subject, value }) => (
              <div key={subject} style={{
                background: 'rgba(56,189,248,0.08)',
                border: '1px solid rgba(56,189,248,0.2)',
                borderRadius: '6px',
                padding: '0.35rem 0.25rem',
                textAlign: 'center',
              }}>
                <div style={{ fontSize: '0.62rem', color: '#64748b', marginBottom: '0.15rem', lineHeight: 1.2 }}>
                  {subject}
                </div>
                <div style={{ fontSize: '0.9rem', fontWeight: 700, color: '#38bdf8' }}>
                  {value.toFixed(0)}
                </div>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
};

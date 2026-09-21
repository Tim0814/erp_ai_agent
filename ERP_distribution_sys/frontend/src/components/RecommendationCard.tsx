import React from 'react';
import { Recommendation, ReviewAction } from '../types';
import { CheckCircle2, Edit3, XCircle, AlertTriangle, ShieldCheck, Ban } from 'lucide-react';

interface RecommendationCardProps {
  rec: Recommendation;
  onApprove: (id: string) => void;
  onOverride: (rec: Recommendation) => void;
  onReject: (id: string) => void;
  onCancel: (salesOrder: string) => void;
}

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
    // yellow
    return { cardClass: 'status-orange', badgeClass: 'badge-orange', label: '建議複核' };
  };

  const theme = getStatusTheme();

  // 子分數統一轉型（DB 可能回傳字串）
  const fefo       = Number(rec.fefo_score);
  const urgency    = Number(rec.urgency_score);
  const orderTime  = Number(rec.order_time_score);
  const custTier   = Number(rec.customer_tier_score);
  const region     = Number(rec.region_score);

  return (
    <div className={`card ${theme.cardClass}`}>
      <div>
        {/* 卡片頂部：訂單編號 + 商品代碼 + 總分 */}
        <div className="card-header">
          <div>
            <div className="order-id">
              {rec.sales_order}
              <span style={{ marginLeft: '0.5rem', fontSize: '0.75rem', color: '#94a3b8' }}>
                #{rec.item_code}
              </span>
            </div>
            <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
              總分:{' '}
              <strong style={{ color: '#ffffff', fontSize: '0.9rem' }}>
                {Number(rec.score).toFixed(1)}
              </strong>
            </span>
          </div>
          <span className={`badge ${theme.badgeClass}`}>{theme.label}</span>
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
                倉庫:{' '}
                <strong style={{ color: '#10b981' }}>{rec.warehouse}</strong>
              </div>
            </div>
          )}
        </div>

        {/* 五維度分數細節 */}
        <div className="score-breakdown-grid">
          <div className="score-pill">
            <span className="score-pill-label">效期 (FEFO)</span>
            <span className="score-pill-val">{fefo.toFixed(0)}</span>
          </div>
          <div className="score-pill">
            <span className="score-pill-label">急迫性</span>
            <span className="score-pill-val">{urgency.toFixed(0)}</span>
          </div>
          <div className="score-pill">
            <span className="score-pill-label">下單先後</span>
            <span className="score-pill-val">{orderTime.toFixed(0)}</span>
          </div>
          <div className="score-pill">
            <span className="score-pill-label">客戶等級</span>
            <span className="score-pill-val">{custTier.toFixed(0)}</span>
          </div>
          <div className="score-pill">
            <span className="score-pill-label">區域集群</span>
            <span className="score-pill-val">{region.toFixed(0)}</span>
          </div>
        </div>

        {/* AI 說明文字 */}
        <div className="ai-explanation">
          💡 <strong>AI 說明：</strong> {rec.rationale || '系統評估完成'}
        </div>

        {/* 已審核狀態顯示：依 is_overridden + status 判斷，不讀取 review_action */}
        {(rec.is_overridden || rec.status === 'approved' || rec.status === 'rejected') && (
          <div style={{ marginBottom: '1rem' }}>
            {rec.is_overridden && (
              <div
                className="review-badge"
                style={{ background: 'rgba(245, 158, 11, 0.2)', color: '#f59e0b', width: '100%' }}
              >
                ✏️ 已覆寫：{rec.override_reason}
              </div>
            )}
            {!rec.is_overridden && rec.status === 'approved' && (
              <span
                className="review-badge"
                style={{ background: 'rgba(16, 185, 129, 0.2)', color: '#10b981' }}
              >
                <ShieldCheck size={12} style={{ display: 'inline', marginRight: 4 }} /> 已核准確認
              </span>
            )}
            {rec.status === 'rejected' && (
              <span
                className="review-badge"
                style={{ background: 'rgba(239, 68, 68, 0.2)', color: '#ef4444' }}
              >
                ❌ 已退回單據
              </span>
            )}
          </div>
        )}
      </div>

      {/* 操作按鈕：紅燈時核准按鈕 disabled，覆寫與退回保持可操作 */}
      <div className="card-actions">
        <button
          className="btn btn-sm btn-approve"
          onClick={() => onApprove(rec.id)}
          disabled={rec.traffic_light === 'red'}
          title={rec.traffic_light === 'red' ? '紅燈案例不可直接核准，請覆寫或退回' : undefined}
        >
          <CheckCircle2 size={14} /> 核准
        </button>
        <button className="btn btn-sm btn-override" onClick={() => onOverride(rec)}>
          <Edit3 size={14} /> 覆寫
        </button>
        <button className="btn btn-sm btn-reject" onClick={() => onReject(rec.id)}>
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

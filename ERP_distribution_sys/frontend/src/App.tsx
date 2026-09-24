import React, { useState, useEffect } from 'react';
import { Recommendation } from './types';
import { RecommendationCard } from './components/RecommendationCard';
import { OverrideModal } from './components/OverrideModal';
import { Play, Download, RefreshCw, CheckCircle, AlertOctagon, Settings, UserCheck, Trash2 } from 'lucide-react';

// ── 操作者清單（假名，可自行修改）────────────────────────────────────────────
const OPERATOR_LIST = [
  '王大明',
  '林小華',
  '陳志偉',
  '張美玲',
  '李建國',
] as const;

// ── 規則 enabled 欄位型別 ──────────────────────────────────────────────────────

interface RuleEnabledState {
  fefo_enabled: boolean;
  urgency_enabled: boolean;
  order_time_enabled: boolean;
  customer_tier_enabled: boolean;
  region_enabled: boolean;
}

const RULE_LABELS: { field: keyof RuleEnabledState; label: string }[] = [
  { field: 'fefo_enabled',          label: '先效期先出（FEFO）' },
  { field: 'urgency_enabled',       label: '緊急度' },
  { field: 'order_time_enabled',    label: '下單時間' },
  { field: 'customer_tier_enabled', label: '客戶等級' },
  { field: 'region_enabled',        label: '區域群聚' },
];

// ──────────────────────────────────────────────────────────────────────────────

export const App: React.FC = () => {
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [overrideModalRec, setOverrideModalRec] = useState<Recommendation | null>(null);

  // ── 操作者身分聲明（sessionStorage 跨重整保留）────────────────────────────
  const [operator, setOperator] = useState<string>(
    () => sessionStorage.getItem('erp_operator') ?? '',
  );

  // 規則啟用狀態（null = 尚未從 API 載入）
  const [ruleEnabled, setRuleEnabled] = useState<RuleEnabledState | null>(null);
  const [rulesLoading, setRulesLoading] = useState<boolean>(false);
  const [settingsChanged, setSettingsChanged] = useState<boolean>(false);

  const fetchRecommendations = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/recommendations');
      const data = await res.json();
      if (data.success) {
        setRecommendations(data.data);
      }
    } catch (err) {
      console.error('無法取得分配建議:', err);
    } finally {
      setLoading(false);
    }
  };

  // 讀取 company_weights enabled 狀態
  const fetchRuleEnabled = async () => {
    try {
      const res = await fetch('/api/company-weights');
      if (!res.ok) return;
      const data = await res.json();
      if (data.success && data.data) {
        setRuleEnabled(data.data as RuleEnabledState);
      }
    } catch (err) {
      console.error('無法取得規則啟用狀態:', err);
    }
  };

  const handleRunAllocation = async () => {
    setSettingsChanged(false);
    try {
      setLoading(true);
      const res = await fetch('/api/run-allocation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();

      // 檢查 HTTP 狀態碼
      if (!res.ok) {
        const details: string = data.details || '';
        // dataSource throw 的錯誤訊息會帶有 [dataSource] 前綴，
        // 用來判斷是資料來源異常，給使用者更明確的提示
        const isDataSourceError = details.includes('[dataSource]');
        if (isDataSourceError) {
          alert(`資料來源異常：無法讀取訂單／客戶／批次資料，請確認 Supabase 連線正常。\n\n詳細原因：${details}`);
        } else {
          alert(`執行分配引擎失敗: ${data.error || '未知錯誤'}\n詳細資訊: ${details || '無'}`);
        }
        return;
      }

      if (data.success) {
        setRecommendations(data.data);
      }
    } catch (err) {
      // fetch 本身拋錯代表網路層完全無法連線（後端 process 未啟動或 DNS 失敗），
      // 與 Supabase 查詢失敗（HTTP 500）是不同的錯誤路徑
      alert('無法連線到分配引擎 API，請確認後端服務是否正常啟動。');
    } finally {
      setLoading(false);
    }
  };

  const handleReviewAction = async (recId: string, action: 'approved' | 'overridden' | 'rejected', overrideReason?: string) => {
    if (!operator) {
      alert('請先在右上角選擇操作者身分，再執行審核動作。');
      return;
    }
    try {
      const res = await fetch(`/api/review/${recId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, override_reason: overrideReason, operator }),
      });
      const data = await res.json();
      if (data.success) {
        setRecommendations((prev) =>
          prev.map((r) => (r.id === recId ? data.data : r))
        );
      }
    } catch (err) {
      alert('審核更新失敗: ' + err);
    }
  };

  const handleExportCSV = () => {
    window.open('/api/export/csv', '_blank');
  };

  const handleCancelOrder = async (salesOrder: string) => {
    const confirmed = window.confirm(
      `確定要棄單訂單 ${salesOrder} 嗎？此動作會將現有分配建議標記為取消，且無法復原。`,
    );
    if (!confirmed) return;

    try {
      setLoading(true);
      const res = await fetch(`/api/orders/${encodeURIComponent(salesOrder)}/cancel`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || '棄單失敗');
      }

      const releasedBatchIds = Array.isArray(data.released_batch_ids)
        ? data.released_batch_ids
        : [];
      alert(
        releasedBatchIds.length > 0
          ? `訂單 ${salesOrder} 已棄單，已釋放批次：${releasedBatchIds.join(', ')}`
          : `訂單 ${salesOrder} 已棄單，沒有需要釋放的批次。`,
      );
      await fetchRecommendations();
    } catch (err) {
      alert(`棄單失敗：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleReallocate = async () => {
    const itemCode = window.prompt('請輸入要重新分配的商品代碼，例如 PROD-MILK-01：')?.trim();
    if (!itemCode) return;

    try {
      setLoading(true);
      const res = await fetch('/api/reallocate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_code: itemCode }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || '重新分配失敗');
      }

      alert(`商品 ${itemCode} 已重新分配，產生 ${Number(data.count ?? 0)} 筆新建議。`);
      await fetchRecommendations();
    } catch (err) {
      alert(`重新分配失敗：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  // 清空分配建議（開發模式按鈕，VITE_ENABLE_RESET_BUTTON=true 才渲染）
  const handleResetRecommendations = async () => {
    const input = window.prompt(
      '⚠️ 此操作將清空所有分配建議，且無法復原。請輸入「確認清空」以繼續：',
    );
    // 使用者取消 prompt 或輸入不符
    if (input === null) return;
    if (input.trim() !== '確認清空') {
      alert('輸入不符，操作已取消。');
      return;
    }

    try {
      setLoading(true);
      const res = await fetch('/api/admin/reset-recommendations', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.details || data.error || '清空失敗');
      }
      alert(`已重置，共刪除 ${Number(data.deleted_count ?? 0)} 筆。`);
      // 清空後重新整理前端列表
      setRecommendations([]);
    } catch (err) {
      alert(`清空失敗：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  // 勾選/取消勾選規則
  const handleRuleToggle = async (field: keyof RuleEnabledState, newValue: boolean) => {
    if (!ruleEnabled) return;

    // 前端護欄：若只剩 1 個啟用，不允許取消
    const enabledCount = Object.values(ruleEnabled).filter(Boolean).length;
    if (!newValue && enabledCount <= 1) return; // 理論上 disabled 已攔截，這裡雙重保險

    // 樂觀更新 UI
    setRuleEnabled((prev) => prev ? { ...prev, [field]: newValue } : prev);
    setRulesLoading(true);

    try {
      const res = await fetch('/api/company-weights', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field, value: newValue }),
      });
      const data = await res.json();
      if (data.success && data.data) {
        // 以伺服器回傳值為準，確保前後端一致
        setRuleEnabled(data.data as RuleEnabledState);
        setSettingsChanged(true);
      } else {
        // 寫入失敗，回滾 UI
        setRuleEnabled((prev) => prev ? { ...prev, [field]: !newValue } : prev);
        alert(`規則更新失敗: ${data.error || '未知錯誤'}`);
      }
    } catch (err) {
      // 網路錯誤，回滾 UI
      setRuleEnabled((prev) => prev ? { ...prev, [field]: !newValue } : prev);
      alert('規則更新失敗，請確認後端連線正常');
    } finally {
      setRulesLoading(false);
    }
  };

  useEffect(() => {
    fetchRecommendations();
    fetchRuleEnabled();
  }, []);

  // 分區過濾（依燈號分類，與審核流程 status 無關）
  const visibleRecommendations = recommendations.filter((r) => r.status !== 'cancelled');
  const autoConfirmList = visibleRecommendations.filter((r) => r.traffic_light === 'green');
  const manualReviewList = visibleRecommendations.filter((r) => r.traffic_light === 'yellow' || r.traffic_light === 'red');

  // 計算目前啟用的規則數，用於決定 checkbox 是否 disabled
  const enabledCount = ruleEnabled ? Object.values(ruleEnabled).filter(Boolean).length : 0;

  return (
    <div className="dashboard-container">
      {/* 頂部 Header */}
      <header className="header">
        <div className="title-group">
          <h1>食品供應鏈 ERP 分配輔助系統</h1>
          <p>規則引擎加權評分 + LLM 白話解釋 + 人工覆寫稽核機制 (PoC Phase 1)</p>
        </div>
        <div className="action-bar">
          <button className="btn btn-primary" onClick={handleRunAllocation} disabled={loading}>
            <Play size={16} /> {loading ? '計算中...' : '執行分配引擎'}
          </button>
          <button className="btn btn-secondary" onClick={handleExportCSV}>
            <Download size={16} /> 匯出 CSV
          </button>
          <button className="btn btn-secondary" onClick={handleReallocate} disabled={loading}>
            <RefreshCw size={16} /> 重新分配
          </button>
          <button className="btn btn-secondary" onClick={fetchRecommendations} disabled={loading}>
            <RefreshCw size={16} className={loading ? 'spin' : ''} /> 重新整理
          </button>
          {/* ── 開發用清空按鈕：VITE_ENABLE_RESET_BUTTON=true 才渲染，預設不顯示 ── */}
          {import.meta.env.VITE_ENABLE_RESET_BUTTON === 'true' && (
            <button
              className="btn btn-secondary"
              onClick={handleResetRecommendations}
              disabled={loading}
              style={{ borderColor: 'rgba(239,68,68,0.4)', color: '#ef4444' }}
              title="清空 allocation_recommendations（開發模式）"
            >
              <Trash2 size={16} /> 清空建議
            </button>
          )}
          {/* ── 操作者身分聲明選單 ── */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginLeft: '0.75rem' }}>
            <UserCheck size={15} style={{ color: operator ? '#10b981' : '#64748b', flexShrink: 0 }} />
            <select
              value={operator}
              onChange={(e) => {
                const v = e.target.value;
                setOperator(v);
                sessionStorage.setItem('erp_operator', v);
              }}
              style={{
                background: 'rgba(255,255,255,0.06)',
                border: `1px solid ${operator ? 'rgba(16,185,129,0.5)' : 'rgba(255,255,255,0.15)'}`,
                borderRadius: '0.4rem',
                color: operator ? '#e2e8f0' : '#64748b',
                fontSize: '0.82rem',
                padding: '0.35rem 0.6rem',
                cursor: 'pointer',
                outline: 'none',
              }}
            >
              <option value="">── 選擇操作者 ──</option>
              {OPERATOR_LIST.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </div>
        </div>
      </header>

      {/* 規則設定區塊 */}
      <section className="rules-panel">
        <div className="rules-panel-title">
          <Settings size={16} />
          <span>評分規則設定</span>
          {rulesLoading && <span className="rules-saving-hint">儲存中…</span>}
        </div>
        {ruleEnabled === null ? (
          <p className="rules-loading-hint">載入中…</p>
        ) : (
          <div className="rules-checkboxes">
            {RULE_LABELS.map(({ field, label }) => {
              const checked = ruleEnabled[field];
              // 當只剩最後一個啟用時，那個 checkbox 不可取消
              const isLastEnabled = checked && enabledCount === 1;
              return (
                <label
                  key={field}
                  className={`rule-checkbox-label${isLastEnabled ? ' rule-checkbox-disabled' : ''}`}
                  title={isLastEnabled ? '至少需保留一項規則啟用' : undefined}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={isLastEnabled || rulesLoading}
                    onChange={(e) => handleRuleToggle(field, e.target.checked)}
                  />
                  <span>{label}</span>
                </label>
              );
            })}
          </div>
        )}
        {settingsChanged && (
          <p style={{ color: '#f59e0b', fontSize: '0.85rem', margin: '0.5rem 0 0' }}>
            ⚠️ 設定已更新，請按上方「執行分配引擎」以套用新規則到分配建議
          </p>
        )}
      </section>

      {/* 區塊 1: 可直接確認 (Total Score >= 80) */}
      <section className="zone-section">
        <div className="zone-title" style={{ color: '#10b981' }}>
          <CheckCircle size={22} />
          <span>區域一：可直接確認（綠燈）</span>
          <span className="zone-badge-count" style={{ background: 'rgba(16, 185, 129, 0.2)', color: '#10b981' }}>
            {autoConfirmList.length} 筆
          </span>
        </div>
        {autoConfirmList.length === 0 ? (
          <p style={{ color: '#64748b', fontSize: '0.9rem' }}>尚無自動建議項，請按右上角「執行分配引擎」。</p>
        ) : (
          <div className="cards-grid">
            {autoConfirmList.map((rec) => (
              <RecommendationCard
                key={rec.id}
                rec={rec}
                onApprove={(id) => handleReviewAction(id, 'approved')}
                onOverride={(r) => setOverrideModalRec(r)}
                onReject={(id) => handleReviewAction(id, 'rejected')}
                onCancel={handleCancelOrder}
              />
            ))}
          </div>
        )}
      </section>

      {/* 區塊 2: 需人工處理 / 建議複核 (Blocked 或 Score < 80) */}
      <section className="zone-section">
        <div className="zone-title" style={{ color: '#f59e0b' }}>
          <AlertOctagon size={22} />
          <span>區域二：需人工處理 / 建議複核（黃燈 / 紅燈）</span>
          <span className="zone-badge-count" style={{ background: 'rgba(245, 158, 11, 0.2)', color: '#f59e0b' }}>
            {manualReviewList.length} 筆
          </span>
        </div>
        {manualReviewList.length === 0 ? (
          <p style={{ color: '#64748b', fontSize: '0.9rem' }}>無待處理的阻斷或複核單據。</p>
        ) : (
          <div className="cards-grid">
            {manualReviewList.map((rec) => (
              <RecommendationCard
                key={rec.id}
                rec={rec}
                onApprove={(id) => handleReviewAction(id, 'approved')}
                onOverride={(r) => setOverrideModalRec(r)}
                onReject={(id) => handleReviewAction(id, 'rejected')}
                onCancel={handleCancelOrder}
              />
            ))}
          </div>
        )}
      </section>

      {/* 覆寫原因 Modal */}
      {overrideModalRec && (
        <OverrideModal
          rec={overrideModalRec}
          onClose={() => setOverrideModalRec(null)}
          onSubmit={(id, action, reason) => handleReviewAction(id, action, reason)}
        />
      )}
    </div>
  );
};

import React, { useState, useEffect } from 'react';
import { Recommendation } from './types';
import { RecommendationCard } from './components/RecommendationCard';
import { OverrideModal } from './components/OverrideModal';
import { Play, Download, RefreshCw, CheckCircle, AlertOctagon, Settings } from 'lucide-react';

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

  // 規則啟用狀態（null = 尚未從 API 載入）
  const [ruleEnabled, setRuleEnabled] = useState<RuleEnabledState | null>(null);
  const [rulesLoading, setRulesLoading] = useState<boolean>(false);

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
    try {
      setLoading(true);
      const res = await fetch('/api/run-allocation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      
      // 檢查 HTTP 狀態碼
      if (!res.ok) {
        alert(`執行分配引擎失敗: ${data.error || '未知錯誤'}\n詳細資訊: ${data.details || '無'}`);
        return;
      }
      
      if (data.success) {
        setRecommendations(data.data);
      }
    } catch (err) {
      alert('觸發分配引擎失敗，請檢查後端 (FastAPI:8000 與 Engine:4000) 是否啟動');
    } finally {
      setLoading(false);
    }
  };

  const handleReviewAction = async (recId: string, action: 'approved' | 'overridden' | 'rejected', overrideReason?: string) => {
    try {
      const res = await fetch(`/api/review/${recId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, override_reason: overrideReason }),
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
  const autoConfirmList = recommendations.filter((r) => r.traffic_light === 'green');
  const manualReviewList = recommendations.filter((r) => r.traffic_light === 'yellow' || r.traffic_light === 'red');

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
          <button className="btn btn-secondary" onClick={fetchRecommendations} disabled={loading}>
            <RefreshCw size={16} className={loading ? 'spin' : ''} /> 重新整理
          </button>
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

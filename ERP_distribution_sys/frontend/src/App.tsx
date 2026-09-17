import React, { useState, useEffect } from 'react';
import { Recommendation } from './types';
import { RecommendationCard } from './components/RecommendationCard';
import { OverrideModal } from './components/OverrideModal';
import { Play, Download, RefreshCw, CheckCircle, AlertOctagon } from 'lucide-react';

export const App: React.FC = () => {
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [overrideModalRec, setOverrideModalRec] = useState<Recommendation | null>(null);

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

  useEffect(() => {
    fetchRecommendations();
  }, []);

  // 分區過濾（依燈號分類，與審核流程 status 無關）
  const autoConfirmList = recommendations.filter((r) => r.traffic_light === 'green');
  const manualReviewList = recommendations.filter((r) => r.traffic_light === 'yellow' || r.traffic_light === 'red');

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

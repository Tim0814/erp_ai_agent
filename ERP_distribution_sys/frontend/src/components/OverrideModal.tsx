import React, { useState } from 'react';
import { Recommendation } from '../types';

interface OverrideModalProps {
  rec: Recommendation;
  onClose: () => void;
  onSubmit: (recId: string, action: 'overridden', reason: string) => void;
}

export const OverrideModal: React.FC<OverrideModalProps> = ({ rec, onClose, onSubmit }) => {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) {
      setError('覆寫分配建議時，必須填寫覆寫原因！');
      return;
    }
    onSubmit(rec.id, 'overridden', reason.trim());
    onClose();
  };

  return (
    <div className="modal-backdrop">
      <div className="modal-box">
        <h3 className="modal-title">
          ✏️ 人工覆寫分配建議 - {rec.sales_order}
          <span style={{ marginLeft: '0.4rem', fontSize: '0.8rem', color: '#94a3b8' }}>
            #{rec.item_code}
          </span>
        </h3>
        <p style={{ fontSize: '0.85rem', color: '#94a3b8', marginBottom: '1rem' }}>
          原系統建議批次：<strong>{rec.batch_id || '無'}</strong>
          {' '}(加權總分: {Number(rec.score).toFixed(1)})
        </p>

        <form onSubmit={handleSubmit}>
          <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.5rem' }}>
            覆寫原因 <span style={{ color: '#ef4444' }}>* (必填)</span>
          </label>
          <textarea
            className="textarea-field"
            placeholder="例如：客戶特別指定調撥 A 倉近效期批次，或是品質稽核例外核准..."
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              if (error) setError('');
            }}
          />

          {error && (
            <p style={{ color: '#ef4444', fontSize: '0.8rem', marginBottom: '1rem', fontWeight: 600 }}>
              ⚠️ {error}
            </p>
          )}

          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              取消
            </button>
            <button type="submit" className="btn btn-primary" style={{ background: '#f59e0b' }}>
              確認覆寫
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

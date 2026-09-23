-- Migration: 新增 sales_orders.created_by 欄位
-- 記錄在 ERPNext 中建立此訂單的使用者帳號（對應 ERPNext Sales Order 的 owner 欄位）
-- 可為 NULL：舊資料或非同步產生的訂單不會有這個值

ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS created_by TEXT;

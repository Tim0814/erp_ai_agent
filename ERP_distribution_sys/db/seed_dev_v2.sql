-- =============================================================================
-- 開發用測試資料 v2（對齊 8 張表新 schema）
-- ⚠️  僅供開發測試使用，可隨時清空重灌，請勿在正式環境執行。
-- 取代舊版 db/seed_dev.sql（該檔案是照舊版 2 張表 schema 設計，已作廢，建議刪除）
--
-- 清空方式：
--   TRUNCATE allocation_recommendations, sales_order_items, sales_orders,
--            inventory, batches, items, customers, company_weights CASCADE;
--
-- 設計基準時間：今天視為 2026-09-16，所有效期/交期都以此為參考點設計。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. items：3 種商品，用來驗證 Prompt B 的「同商品過濾」邏輯有沒有生效
-- -----------------------------------------------------------------------------
INSERT INTO items (item_code, item_name, item_group, stock_uom, description) VALUES
('PROD-MILK-01',   '鮮乳',   'Finished Goods', 'Box', '鮮乳，冷藏保存'),
('PROD-YOGURT-01', '優格',   'Finished Goods', 'Box', '優格，冷藏保存'),
('PROD-CHEESE-01', '起司',   'Finished Goods', 'Box', '起司，冷藏保存');

-- -----------------------------------------------------------------------------
-- 2. batches：7 個批次，涵蓋正常、已過期、零庫存、短缺、交期衝突五種情境
-- -----------------------------------------------------------------------------
INSERT INTO batches (batch_id, item_code, manufacturing_date, expiry_date, batch_qty) VALUES
-- 正常鮮乳批次：效期較遠
('BAT-101', 'PROD-MILK-01', '2026-09-01', '2026-09-30', 200),
-- 正常鮮乳批次：效期較近（FEFO 應優先選這批）
('BAT-102', 'PROD-MILK-01', '2026-09-05', '2026-09-22', 150),
-- 優格批次：唯一供應 SO-3 的批次
('BAT-103', 'PROD-YOGURT-01', '2026-09-01', '2026-10-15', 500),
-- 零庫存批次：驗證硬性規則有排除掉庫存為 0 的批次
('BAT-104', 'PROD-MILK-01', '2026-08-20', '2026-09-25', 0),
-- 已過期批次（以 2026-09-16 為基準，此批次已過期）：驗證硬性規則排除已過期批次
('BAT-105', 'PROD-MILK-01', '2026-08-01', '2026-09-10', 300),
-- 起司批次：庫存量刻意設得很小 → 對應 SO-4 的數量短缺案例
('BAT-106', 'PROD-CHEESE-01', '2026-09-01', '2026-10-01', 50),
-- 鮮乳大量批次：庫存足夠但效期會在 SO-5 要求的交期之前到期 → 交期衝突案例
('BAT-107', 'PROD-MILK-01', '2026-08-25', '2026-09-19', 600);

-- -----------------------------------------------------------------------------
-- 3. inventory：每個批次對應一筆庫存記錄
-- warehouse 欄位刻意直接使用 'NORTH'/'SOUTH' 字串，跟 customers.territory 對齊，
-- 這樣區域群聚評分（字串完全比對）才測得出差異。
-- -----------------------------------------------------------------------------
INSERT INTO inventory (item_code, batch_id, warehouse, actual_qty) VALUES
('PROD-MILK-01',   'BAT-101', 'NORTH', 200),
('PROD-MILK-01',   'BAT-102', 'NORTH', 150),
('PROD-YOGURT-01', 'BAT-103', 'SOUTH', 500),
('PROD-MILK-01',   'BAT-104', 'NORTH', 0),
('PROD-MILK-01',   'BAT-105', 'NORTH', 300),
('PROD-CHEESE-01', 'BAT-106', 'SOUTH', 50),
('PROD-MILK-01',   'BAT-107', 'NORTH', 600);

-- -----------------------------------------------------------------------------
-- 4. customers：5 位客戶，涵蓋三種等級、兩個區域，用來測客戶等級與區域評分
-- -----------------------------------------------------------------------------
INSERT INTO customers (customer_name, customer_group, customer_type, territory, customer_tier) VALUES
('CUST-A', 'Distributor', 'Company', 'NORTH', 'vip'),
('CUST-B', 'Retail',      'Company', 'NORTH', 'standard'),
('CUST-C', 'Distributor', 'Company', 'SOUTH', 'standard'),
('CUST-D', 'Retail',      'Company', 'SOUTH', 'new'),
('CUST-E', 'Distributor', 'Company', 'NORTH', 'vip');

-- -----------------------------------------------------------------------------
-- 5. sales_orders：5 筆客戶需求（皆為 Draft，代表尚未處理的客戶需求）
-- transaction_date 刻意錯開，用來測「下單時間」評分維度
-- -----------------------------------------------------------------------------
INSERT INTO sales_orders (name, customer_name, transaction_date, delivery_date, status, grand_total) VALUES
('SO-2026-00001', 'CUST-A', '2026-09-01', '2026-09-20', 'Draft', 5000),   -- 正常案例
('SO-2026-00002', 'CUST-B', '2026-09-05', '2026-09-19', 'Draft', 6500),   -- 正常案例
('SO-2026-00003', 'CUST-C', '2026-09-08', '2026-09-25', 'Draft', 12000),  -- 正常案例，測跨商品過濾+區域比對
('SO-2026-00004', 'CUST-D', '2026-09-10', '2026-09-28', 'Draft', 16000),  -- 數量短缺案例
('SO-2026-00005', 'CUST-E', '2026-09-12', '2026-09-25', 'Draft', 27500);  -- 交期衝突案例

-- -----------------------------------------------------------------------------
-- 6. sales_order_items：每筆訂單一個品項（對應引擎的一筆 Order）
-- -----------------------------------------------------------------------------
INSERT INTO sales_order_items (parent, item_code, qty, rate, delivery_date) VALUES
('SO-2026-00001', 'PROD-MILK-01',   100, 50, '2026-09-20'),
('SO-2026-00002', 'PROD-MILK-01',   130, 50, '2026-09-19'),
('SO-2026-00003', 'PROD-YOGURT-01', 300, 40, '2026-09-25'),
('SO-2026-00004', 'PROD-CHEESE-01', 200, 80, '2026-09-28'),  -- 只有 BAT-106（50件）可用，明顯短缺
('SO-2026-00005', 'PROD-MILK-01',   550, 50, '2026-09-25');  -- 唯一夠量的 BAT-107 會在交期前過期

-- -----------------------------------------------------------------------------
-- 7. company_weights：預設權重設定（五項全部啟用，加總 = 1.0）
-- -----------------------------------------------------------------------------
INSERT INTO company_weights
  (fefo_weight, urgency_weight, order_time_weight, customer_tier_weight, region_weight,
   fefo_enabled, urgency_enabled, order_time_enabled, customer_tier_enabled, region_enabled,
   profile_name)
VALUES
  (0.30, 0.25, 0.15, 0.20, 0.10, TRUE, TRUE, TRUE, TRUE, TRUE, 'default');

-- -----------------------------------------------------------------------------
-- 8. allocation_recommendations：刻意不預先塞假資料
-- 理由：這張表的內容應該由分配引擎實際跑過上述 5 筆客戶需求後產生，
--       而不是像舊版 seed_dev.sql 那樣手動塞 10 筆假結果。
--       用真實引擎跑出來的結果做 demo，才能保證畫面上看到的分數/燈號/理由
--       跟你們的加權邏輯是真的對得上的。
--
-- 驗證方式：資料灌完後，直接呼叫 POST /api/run-allocation，
--          預期會產生 5 筆建議，其中 SO-2026-00004（起司短缺）
--          與 SO-2026-00005（鮮乳交期衝突）這兩筆應該會被標記為
--          traffic_light = 'red'，其餘三筆應為 'green' 或 'yellow'。
-- =============================================================================
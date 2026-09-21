-- Preserve allocation audit history across ERPNext syncs.
--
-- allocation_recommendations stores an audit snapshot keyed by business values
-- (sales_order, item_code, batch_id). The source tables are intentionally
-- rebuilt by syncFromErpnext.ts, so recommendations must not have foreign keys
-- to those mutable rows or to sales_order_items.name (a BIGSERIAL value).
--
-- Run this migration after inspecting the live schema. The catalog checks make
-- it safe to run when one or more constraints do not exist.

DO $$
DECLARE
  constraint_record RECORD;
BEGIN
  FOR constraint_record IN
    SELECT ns.nspname AS schema_name,
           cls.relname AS table_name,
           con.conname AS constraint_name
      FROM pg_constraint con
      JOIN pg_class cls ON cls.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = cls.relnamespace
      JOIN pg_class referenced_cls ON referenced_cls.oid = con.confrelid
     WHERE con.contype = 'f'
       AND ns.nspname = 'public'
       AND cls.relname = 'allocation_recommendations'
       AND referenced_cls.relname IN (
         'sales_order_items',
         'sales_orders',
         'items',
         'batches',
         'inventory',
         'customers'
       )
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I DROP CONSTRAINT %I',
      constraint_record.schema_name,
      constraint_record.table_name,
      constraint_record.constraint_name
    );
  END LOOP;
END
$$;

CREATE INDEX IF NOT EXISTS allocation_recommendations_business_key_idx
  ON public.allocation_recommendations (sales_order, item_code);

CREATE INDEX IF NOT EXISTS allocation_recommendations_active_batch_idx
  ON public.allocation_recommendations (sales_order, batch_id)
  WHERE status NOT IN ('cancelled', 'rejected');

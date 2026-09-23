import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { calculateATPBreakdown } from '../lib/atp.js';

function getQueryValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const itemCode = getQueryValue(req.query.item_code).trim();
  const date = getQueryValue(req.query.date).trim() || new Date().toISOString().slice(0, 10);
  const warehouse = getQueryValue(req.query.warehouse).trim();

  if (!itemCode) return res.status(400).json({ error: 'item_code is required' });
  if (!isIsoDate(date)) return res.status(400).json({ error: 'date must be a valid YYYY-MM-DD date' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseKey);
    let warehouses = warehouse ? [warehouse] : [];

    if (!warehouse) {
      const [{ data: inventoryRows, error: inventoryError }, { data: allocationRows, error: allocationError }] =
        await Promise.all([
          supabase.from('inventory').select('warehouse').eq('item_code', itemCode),
          supabase.from('allocation_recommendations').select('warehouse').eq('item_code', itemCode),
        ]);

      if (inventoryError) throw new Error(`查詢 ATP 庫存倉庫失敗：${inventoryError.message}`);
      if (allocationError) throw new Error(`查詢 ATP 分配倉庫失敗：${allocationError.message}`);

      warehouses = [
        ...new Set([
          ...(inventoryRows ?? []).map((row) => String(row.warehouse ?? '').trim()),
          ...(allocationRows ?? []).map((row) => String(row.warehouse ?? '').trim()),
        ]),
      ].filter(Boolean);
    }

    const breakdowns = await Promise.all(
      warehouses.map((currentWarehouse) => calculateATPBreakdown(itemCode, currentWarehouse, date)),
    );
    const breakdown = breakdowns.reduce(
      (total, current) => ({
        totalInventory: total.totalInventory + current.totalInventory,
        allocatedPending: total.allocatedPending + current.allocatedPending,
        availableQty: total.availableQty + current.availableQty,
      }),
      { totalInventory: 0, allocatedPending: 0, availableQty: 0 },
    );

    return res.status(200).json({
      item_code: itemCode,
      date,
      available_qty: breakdown.availableQty,
      breakdown: {
        total_inventory: breakdown.totalInventory,
        allocated_pending: breakdown.allocatedPending,
      },
    });
  } catch (error) {
    console.error('ATP calculation error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

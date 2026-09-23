import 'dotenv/config';

process.env.SUPABASE_ANON_KEY ||= process.env.SUPABASE_SERVICE_ROLE_KEY;

const atpModulePath = '../frontend/lib/atp.ts';
const { calculateATPBreakdown } = await import(atpModulePath);
const date = new Date().toISOString().slice(0, 10);

for (const [itemCode, warehouse] of [
  ['PROD-MILK-01', 'NORTH'],
  ['PROD-CHEESE-01', 'SOUTH'],
] as const) {
  const breakdown = await calculateATPBreakdown(itemCode, warehouse, date);
  console.log(JSON.stringify({
    item_code: itemCode,
    warehouse,
    date,
    available_qty: breakdown.availableQty,
    breakdown: {
      total_inventory: breakdown.totalInventory,
      allocated_pending: breakdown.allocatedPending,
    },
  }));
}

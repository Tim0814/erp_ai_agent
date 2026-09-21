import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { runAllocation } from '../lib/allocationEngine.js';
import {
  fetchBatches,
  fetchCompanyWeights,
  fetchCustomers,
  fetchDraftOrdersByItemCode,
} from '../lib/dataSource.js';
import type { AllocationInput, AllocationResult, Batch, CompanyWeights, Customer, Order } from '../lib/types.js';
import { normalizeEnabledWeights } from '../lib/weights.js';

async function fetchActiveAllocatedBatchIds(
  supabase: SupabaseClient,
  activeSalesOrders: Set<string>,
): Promise<Set<string>> {
  if (activeSalesOrders.size === 0) return new Set<string>();

  const { data, error } = await supabase
    .from('allocation_recommendations')
    .select('batch_id')
    .in('sales_order', [...activeSalesOrders])
    .not('status', 'in', '("cancelled","rejected")');

  if (error) throw new Error(`Failed to fetch allocated batches: ${error.message}`);
  return new Set(
    (data ?? [])
      .map((row: any) => row.batch_id)
      .filter((batchId: unknown): batchId is string => typeof batchId === 'string' && batchId.length > 0),
  );
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const itemCode = typeof req.body?.item_code === 'string' ? req.body.item_code.trim() : '';
  if (!itemCode) return res.status(400).json({ error: 'item_code is required' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseKey);
    const draftOrders = await fetchDraftOrdersByItemCode(itemCode);
    const draftOrderNames = [...new Set(draftOrders.map((order) => order.parentOrderId))];

    const { data: approvedRows, error: approvedError } = draftOrderNames.length === 0
      ? { data: [], error: null }
      : await supabase
        .from('allocation_recommendations')
        .select('sales_order')
        .eq('status', 'approved')
        .in('sales_order', draftOrderNames);
    if (approvedError) throw approvedError;

    const approvedOrders = new Set((approvedRows ?? []).map((row: any) => String(row.sales_order)));
    const orders = draftOrders.filter((order) => !approvedOrders.has(order.parentOrderId));

    if (orders.length === 0) {
      return res.status(200).json({ success: true, item_code: itemCode, count: 0, data: [] });
    }

    const [customers, batches, dbWeights, existingAllocatedBatchIds] = await Promise.all([
      fetchCustomers(),
      fetchBatches(),
      fetchCompanyWeights(),
      fetchActiveAllocatedBatchIds(supabase, new Set(draftOrderNames)),
    ]);
    if (!dbWeights) throw new Error('Company weights are unavailable');

    const input: AllocationInput = {
      orders,
      customers: new Map<string, Customer>(customers.map((customer) => [customer.customerId, customer])),
      batches,
      weights: normalizeEnabledWeights(dbWeights) as CompanyWeights,
    };
    const results = await runAllocation(input, { existingAllocatedBatchIds });
    const records = toRecommendationRecords(results, orders, batches);

    for (const record of records) {
      const { error } = await supabase.from('allocation_recommendations').insert(record);
      if (error) throw new Error(`Failed to insert recommendation: ${error.message}`);
    }

    return res.status(200).json({ success: true, item_code: itemCode, count: records.length, data: records });
  } catch (error) {
    console.error('Reallocate error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

function toRecommendationRecords(results: AllocationResult[], orders: Order[], batches: Batch[]) {
  const now = new Date().toISOString();
  const ordersById = new Map(orders.map((order) => [order.orderId, order]));
  const batchesById = new Map(batches.map((batch) => [batch.batchId, batch]));

  return results.map((result) => {
    const order = ordersById.get(result.orderId)!;
    const batch = result.recommendedBatchId ? batchesById.get(result.recommendedBatchId) : undefined;
    return {
      sales_order: order.parentOrderId,
      item_code: order.itemCode,
      batch_id: result.recommendedBatchId,
      warehouse: batch?.warehouseRegion || 'unassigned',
      recommended_qty: order.requestedQty,
      score: result.totalScore,
      rationale: result.explanation ?? '',
      fefo_score: result.scores.expiry,
      urgency_score: result.scores.urgency,
      order_time_score: result.scores.orderTime,
      customer_tier_score: result.scores.customerTier,
      region_score: result.scores.regionCluster,
      traffic_light: result.signalColor,
      traffic_light_reason: result.signalReason || null,
      status: 'pending',
      created_at: now,
    };
  });
}

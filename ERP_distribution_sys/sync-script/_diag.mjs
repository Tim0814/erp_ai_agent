import http from 'http';

const AUTH = 'token a0b9c69a069cbe8:26110ef99852c0f';

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: 'localhost', port: 8080, path, method: 'GET',
        headers: { Authorization: AUTH, Accept: 'application/json' } },
      res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// ── 1. 列出 Serial and Batch Bundle 文件清單（前 5 筆）─────────────────────────
const q1 = new URLSearchParams({
  fields: JSON.stringify(['name', 'item_code', 'warehouse', 'type_of_transaction',
                          'total_qty', 'voucher_no', 'voucher_type', 'is_cancelled']),
  limit_page_length: '5',
});
const r1 = await get(`/api/resource/Serial%20and%20Batch%20Bundle?${q1}`);
const d1 = JSON.parse(r1.body);
console.log('=== Serial and Batch Bundle list (limit 5) ===');
console.log(JSON.stringify(d1.data, null, 2));

if (!d1.data || d1.data.length === 0) {
  console.log('\n(無 Bundle，請確認 ERPNext 已提交 Stock Entry)');
  process.exit(0);
}

// ── 2. 取第一個 Bundle 的完整文件（含 entries 子表）──────────────────────────
const firstBundleId = encodeURIComponent(d1.data[0].name);
const r2 = await get(`/api/resource/Serial%20and%20Batch%20Bundle/${firstBundleId}`);
const d2 = JSON.parse(r2.body);
console.log('\n=== First Bundle full doc ===');
// 只印 entries 子表內容
const doc = d2.data;
console.log('name:', doc?.name);
console.log('item_code:', doc?.item_code);
console.log('warehouse:', doc?.warehouse);
console.log('entries:', JSON.stringify(doc?.entries, null, 2));

// ── 3. 也試試直接查 Serial and Batch Entry 子表（加 parent filter）────────────
const q3 = new URLSearchParams({
  fields: JSON.stringify(['name', 'parent', 'batch_no', 'qty', 'warehouse', 'item_code']),
  filters: JSON.stringify([['Serial and Batch Entry', 'parent', '=', d1.data[0].name]]),
  limit_page_length: '10',
});
const r3 = await get(`/api/resource/Serial%20and%20Batch%20Entry?${q3}`);
const d3 = JSON.parse(r3.body);
console.log('\n=== Serial and Batch Entry via parent filter ===');
console.log(JSON.stringify(d3.data, null, 2));

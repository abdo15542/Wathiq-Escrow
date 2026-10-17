const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

async function withServer(t, app) {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('health endpoint reports service status', async t => {
  const base = await withServer(t, createApp());
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'ok');
});

test('creates, lists, filters and retrieves offers', async t => {
  const base = await withServer(t, createApp());
  const response = await fetch(`${base}/api/offers`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Buy BNB', asset: 'BNB', price: 600, paymentMethod: 'bank_transfer' })
  });
  assert.equal(response.status, 201);
  const created = (await response.json()).item;
  assert.equal(created.title, 'Buy BNB');
  assert.equal(created.status, 'draft');
  const list = await fetch(`${base}/api/offers?asset=BNB&limit=10`);
  assert.equal((await list.json()).total, 1);
  const get = await fetch(`${base}/api/offers/${created.id}`);
  assert.equal((await get.json()).item.id, created.id);
});

test('rejects invalid offer data and unknown payment methods', async t => {
  const base = await withServer(t, createApp());
  const cases = [
    { title: '', asset: 'BNB', price: 1, paymentMethod: 'bank_transfer' },
    { title: 'Buy BNB', asset: 'BTC', price: 1, paymentMethod: 'bank_transfer' },
    { title: 'Buy BNB', asset: 'BNB', price: Infinity, paymentMethod: 'bank_transfer' },
    { title: 'Buy BNB', asset: 'BNB', price: 1, paymentMethod: 'made_up' },
  ];
  for (const body of cases) {
    const response = await fetch(`${base}/api/offers`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    assert.equal(response.status, 400);
  }
});

test('applies a simple per-client create rate limit', async t => {
  let clock = 1000;
  const base = await withServer(t, createApp({ now: () => clock, maxCreatesPerMinute: 1 }));
  const send = () => fetch(`${base}/api/offers`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Buy BNB', asset: 'BNB', price: 2, paymentMethod: 'crypto' })
  });
  assert.equal((await send()).status, 201);
  assert.equal((await send()).status, 429);
  clock += 60_001;
  assert.equal((await send()).status, 201);
});

test('returns 404 for unknown offers', async t => {
  const base = await withServer(t, createApp());
  assert.equal((await fetch(`${base}/api/offers/99`)).status, 404);
});

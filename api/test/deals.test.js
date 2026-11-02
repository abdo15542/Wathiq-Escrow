const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

const SECRET = 'test-secret-long-enough-for-deals-tests';

async function withServer(t, app) {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

async function register(base, email, displayName) {
  const res = await fetch(base + '/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, displayName, password: 'long-password-123' }),
  });
  assert.equal(res.status, 201, 'register ' + email);
  return res.json();
}

async function call(base, token, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, payload: await res.json() };
}

async function threeUsers(base) {
  const buyer = await register(base, 'buyer@example.com', 'Buyer One');
  const seller = await register(base, 'seller@example.com', 'Seller Two');
  const arbiter = await register(base, 'arbiter@example.com', 'Arbiter Three');
  return { buyer, seller, arbiter };
}

async function createDeal(base, token, overrides = {}) {
  return call(base, token, 'POST', '/api/deals', {
    title: 'Laptop sale with escrow',
    asset: 'BNB',
    amount: 1.25,
    myRole: 'buyer',
    counterpartyEmail: 'seller@example.com',
    arbiterEmail: 'arbiter@example.com',
    ...overrides,
  });
}

test('full deal lifecycle settles by 2-of-3 votes (release wins 2-1)', async t => {
  const base = await withServer(t, createApp({ tokenSecret: SECRET }));
  const { buyer, seller, arbiter } = await threeUsers(base);
  const outsider = await register(base, 'outsider@example.com', 'Out Sider');

  const created = await createDeal(base, buyer.token);
  assert.equal(created.status, 201);
  const deal = created.payload.item;
  assert.equal(deal.status, 'awaiting_funding');
  assert.equal(deal.myRole, 'buyer');
  assert.equal(deal.participants.seller.email, 'seller@example.com');
  assert.equal(deal.participants.arbiter.displayName, 'Arbiter Three');
  assert.equal(deal.amount, 1.25);
  assert.equal(deal.timeoutRefundAt, null);
  const id = deal.id;

  // Visible to all three participants, hidden from everyone else.
  for (const party of [buyer, seller, arbiter]) {
    const mine = await call(base, party.token, 'GET', '/api/my/deals');
    assert.equal(mine.payload.total, 1);
    assert.equal(mine.payload.items[0].id, id);
  }
  const hidden = await call(base, outsider.token, 'GET', '/api/deals/' + id);
  assert.equal(hidden.status, 404);
  const noAuth = await call(base, null, 'GET', '/api/my/deals');
  assert.equal(noAuth.status, 401);

  // Only the buyer can fund.
  assert.equal((await call(base, seller.token, 'POST', `/api/deals/${id}/fund`)).status, 403);
  const funded = await call(base, buyer.token, 'POST', `/api/deals/${id}/fund`);
  assert.equal(funded.status, 200);
  assert.equal(funded.payload.item.status, 'funded');
  assert.ok(funded.payload.item.fundedAt);
  assert.ok(funded.payload.item.timeoutRefundAt);

  // Only the seller can deliver, and only after funding.
  assert.equal((await call(base, buyer.token, 'POST', `/api/deals/${id}/deliver`)).status, 403);
  const delivered = await call(base, seller.token, 'POST', `/api/deals/${id}/deliver`);
  assert.equal(delivered.payload.item.status, 'delivered');

  // Split votes do not settle; the arbiter breaks the tie; double voting is rejected.
  const v1 = await call(base, buyer.token, 'POST', `/api/deals/${id}/vote`, { decision: 'release' });
  assert.equal(v1.payload.item.status, 'delivered');
  assert.equal((await call(base, buyer.token, 'POST', `/api/deals/${id}/vote`, { decision: 'refund' })).status, 409);
  const v2 = await call(base, seller.token, 'POST', `/api/deals/${id}/vote`, { decision: 'refund' });
  assert.equal(v2.payload.item.status, 'delivered');
  const v3 = await call(base, arbiter.token, 'POST', `/api/deals/${id}/vote`, { decision: 'release' });
  assert.equal(v3.payload.item.status, 'released');
  assert.ok(v3.payload.item.settledAt);
  assert.equal((await call(base, seller.token, 'POST', `/api/deals/${id}/vote`, { decision: 'release' })).status, 409);
});

test('two refund votes settle as refunded; dispute opens once and does not block voting', async t => {
  const base = await withServer(t, createApp({ tokenSecret: SECRET }));
  const { buyer, seller, arbiter } = await threeUsers(base);
  const created = await createDeal(base, seller.token, {
    myRole: 'seller',
    counterpartyEmail: 'buyer@example.com',
    title: 'Design service escrow',
  });
  assert.equal(created.status, 201);
  assert.equal(created.payload.item.myRole, 'seller');
  const id = created.payload.item.id;

  await call(base, buyer.token, 'POST', `/api/deals/${id}/fund`);
  const dispute = await call(base, buyer.token, 'POST', `/api/deals/${id}/dispute`, { reason: 'Item not as described' });
  assert.equal(dispute.status, 200);
  assert.equal(dispute.payload.item.dispute, true);
  assert.equal(dispute.payload.item.disputeReason, 'Item not as described');
  assert.equal((await call(base, seller.token, 'POST', `/api/deals/${id}/dispute`, {})).status, 409);

  await call(base, buyer.token, 'POST', `/api/deals/${id}/vote`, { decision: 'refund' });
  const settled = await call(base, arbiter.token, 'POST', `/api/deals/${id}/vote`, { decision: 'refund' });
  assert.equal(settled.payload.item.status, 'refunded');
});

test('unfunded deals can be cancelled by buyer or seller but not the arbiter', async t => {
  const base = await withServer(t, createApp({ tokenSecret: SECRET }));
  const { buyer, seller, arbiter } = await threeUsers(base);
  const created = await createDeal(base, buyer.token);
  const id = created.payload.item.id;
  assert.equal((await call(base, arbiter.token, 'POST', `/api/deals/${id}/cancel`)).status, 403);
  const cancelled = await call(base, seller.token, 'POST', `/api/deals/${id}/cancel`);
  assert.equal(cancelled.payload.item.status, 'cancelled');
  assert.equal((await call(base, buyer.token, 'POST', `/api/deals/${id}/fund`)).status, 409);
});

test('timeout refund unlocks exactly 30 days after funding', async t => {
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  const base = await withServer(t, createApp({ tokenSecret: SECRET, now: () => clock }));
  const { buyer } = await threeUsers(base);
  const created = await createDeal(base, buyer.token);
  const id = created.payload.item.id;
  await call(base, buyer.token, 'POST', `/api/deals/${id}/fund`);

  const early = await call(base, buyer.token, 'POST', `/api/deals/${id}/timeout-refund`);
  assert.equal(early.status, 400);
  clock += 30 * 24 * 60 * 60 * 1000 - 1000;
  // The original token has a 7-day TTL, so after a 30-day jump the buyer
  // signs in again before retrying, exactly like a real client would.
  const relogin = await call(base, null, 'POST', '/api/auth/login', { email: 'buyer@example.com', password: 'long-password-123' });
  assert.equal(relogin.status, 200);
  const freshToken = relogin.payload.token;
  assert.equal((await call(base, freshToken, 'POST', `/api/deals/${id}/timeout-refund`)).status, 400);
  clock += 1000;
  const refunded = await call(base, freshToken, 'POST', `/api/deals/${id}/timeout-refund`);
  assert.equal(refunded.status, 200);
  assert.equal(refunded.payload.item.status, 'refunded');
});

test('deal creation validates participants, amounts, and linked offers', async t => {
  const base = await withServer(t, createApp({ tokenSecret: SECRET }));
  const { buyer, seller } = await threeUsers(base);

  assert.equal((await createDeal(base, buyer.token, { counterpartyEmail: 'ghost@example.com' })).status, 400);
  assert.equal((await createDeal(base, buyer.token, { arbiterEmail: 'ghost@example.com' })).status, 400);
  assert.equal((await createDeal(base, buyer.token, { counterpartyEmail: 'buyer@example.com' })).status, 400);
  assert.equal((await createDeal(base, buyer.token, { arbiterEmail: 'seller@example.com' })).status, 400);
  assert.equal((await createDeal(base, buyer.token, { arbiterEmail: 'buyer@example.com' })).status, 400);
  assert.equal((await createDeal(base, buyer.token, { amount: -1 })).status, 400);
  assert.equal((await createDeal(base, buyer.token, { amount: 0.00000000001 })).status, 400);
  assert.equal((await createDeal(base, buyer.token, { asset: 'DOGE' })).status, 400);
  assert.equal((await createDeal(base, buyer.token, { myRole: 'arbiter' })).status, 400);

  // Seller publishes an offer; the buyer opens a deal linked to it.
  const offer = await call(base, seller.token, 'POST', '/api/offers', {
    title: 'One BNB for sale', asset: 'BNB', price: 600, paymentMethod: 'bank_transfer',
  });
  assert.equal(offer.status, 201);
  const linked = await createDeal(base, buyer.token, { offerId: offer.payload.item.id });
  assert.equal(linked.status, 201);
  assert.equal(linked.payload.item.offerId, offer.payload.item.id);

  // An offer owned by a non-participant cannot be linked.
  const stranger = await register(base, 'stranger@example.com', 'Stran Ger');
  const foreignOffer = await call(base, stranger.token, 'POST', '/api/offers', {
    title: 'Foreign offer here', asset: 'BNB', price: 10, paymentMethod: 'cash',
  });
  assert.equal((await createDeal(base, buyer.token, { offerId: foreignOffer.payload.item.id })).status, 400);
  assert.equal((await createDeal(base, buyer.token, { offerId: 99999 })).status, 404);
});

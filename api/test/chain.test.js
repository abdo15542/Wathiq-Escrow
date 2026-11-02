const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../src/app');
const {
  CREATE_DEAL_SELECTOR,
  DEAL_CREATED_TOPIC,
  amountToTokenUnits,
  decodeCreateDealInput,
  parseDealCreatedLog,
} = require('../src/chain');

const SECRET = 'test-secret-long-enough-for-chain-tests';
const BUYER_WALLET = '0x1111111111111111111111111111111111111111';
const SELLER_WALLET = '0x2222222222222222222222222222222222222222';
const ARBITER_WALLET = '0x3333333333333333333333333333333333333333';
const ESCROW = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TX_HASH = '0x' + 'ab'.repeat(32);

function word(value) {
  // value: BigInt or address string -> 32-byte hex word (no 0x)
  if (typeof value === 'string') return value.replace(/^0x/, '').padStart(64, '0');
  return value.toString(16).padStart(64, '0');
}

function buildInput(seller, arbiter, amountUnits) {
  return CREATE_DEAL_SELECTOR + word(seller) + word(arbiter) + word(amountUnits);
}

function buildLog({ dealId, buyer, seller, arbiter, amountUnits }) {
  return {
    address: ESCROW,
    topics: [DEAL_CREATED_TOPIC, '0x' + word(dealId), '0x' + word(buyer), '0x' + word(seller)],
    data: '0x' + word(arbiter) + word(amountUnits),
    blockNumber: '0x10',
    transactionHash: TX_HASH,
  };
}

function fundingTx({ amountUnits = amountToTokenUnits(250), dealId = 7n } = {}) {
  const tx = {
    hash: TX_HASH,
    from: BUYER_WALLET,
    to: ESCROW,
    input: buildInput(SELLER_WALLET, ARBITER_WALLET, amountUnits),
  };
  const receipt = {
    status: '0x1',
    blockNumber: '0x10',
    logs: [buildLog({ dealId, buyer: BUYER_WALLET, seller: SELLER_WALLET, arbiter: ARBITER_WALLET, amountUnits })],
  };
  return { tx, receipt };
}

async function stubRpc(t, getState) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const call = JSON.parse(raw || '{}');
      const state = getState();
      let result = null;
      if (call.method === 'eth_getTransactionByHash') result = state.tx;
      if (call.method === 'eth_getTransactionReceipt') result = state.receipt;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id || 1, result }));
    });
  });
  server.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

async function withServer(t, app) {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

async function call(base, token, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, payload: await res.json() };
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

async function setupChainDeal(t, { amount = 250, stub = fundingTx() } = {}) {
  const state = { current: stub };
  const rpcUrl = await stubRpc(t, () => state.current);
  const app = createApp({ tokenSecret: SECRET, chain: { rpcUrl, usdtEscrowAddress: ESCROW } });
  const base = await withServer(t, app);
  const buyer = await register(base, 'buyer@example.com', 'Buyer One');
  const seller = await register(base, 'seller@example.com', 'Seller Two');
  const arbiter = await register(base, 'arbiter@example.com', 'Arbiter Three');
  return { base, state, buyer, seller, arbiter };
}

async function setWallet(base, token, walletAddress) {
  const res = await call(base, token, 'PATCH', '/api/auth/me', { walletAddress });
  assert.equal(res.status, 200, 'set wallet');
  return res.payload.user;
}

test('token unit conversion and ABI decoding are exact', () => {
  assert.equal(amountToTokenUnits(250), 250n * 10n ** 18n);
  assert.equal(amountToTokenUnits(0.5), 5n * 10n ** 17n);
  assert.equal(amountToTokenUnits(1.0000000001), 10n ** 18n + 10n ** 8n);
  const input = buildInput(SELLER_WALLET, ARBITER_WALLET, amountToTokenUnits(12.25));
  const decoded = decodeCreateDealInput(input);
  assert.equal(decoded.seller, SELLER_WALLET);
  assert.equal(decoded.arbiter, ARBITER_WALLET);
  assert.equal(decoded.amount, amountToTokenUnits(12.25));
  const log = buildLog({ dealId: 42n, buyer: BUYER_WALLET, seller: SELLER_WALLET, arbiter: ARBITER_WALLET, amountUnits: 99n });
  const parsed = parseDealCreatedLog(log, ESCROW);
  assert.equal(parsed.dealId, 42n);
  assert.equal(parsed.buyer, BUYER_WALLET);
  assert.equal(parsed.arbiter, ARBITER_WALLET);
  assert.equal(parsed.amount, 99n);
  assert.equal(parseDealCreatedLog({ ...log, address: BUYER_WALLET }, ESCROW), null);
});

test('wallet addresses can be set, read back, validated and cleared', async t => {
  const app = createApp({ tokenSecret: SECRET });
  const base = await withServer(t, app);
  const user = await register(base, 'wallet@example.com', 'Wallet User');
  assert.equal(user.user.walletAddress, null);
  const updated = await setWallet(base, user.token, BUYER_WALLET.toUpperCase().replace('0X', '0x'));
  assert.equal(updated.walletAddress, BUYER_WALLET);
  const bad = await call(base, user.token, 'PATCH', '/api/auth/me', { walletAddress: 'not-an-address' });
  assert.equal(bad.status, 400);
  const cleared = await call(base, user.token, 'PATCH', '/api/auth/me', { walletAddress: null });
  assert.equal(cleared.payload.user.walletAddress, null);
});

test('buyer links verified on-chain funding and the deal becomes funded', async t => {
  const { base, buyer, seller, arbiter } = await setupChainDeal(t);
  await setWallet(base, buyer.token, BUYER_WALLET);
  await setWallet(base, seller.token, SELLER_WALLET);
  await setWallet(base, arbiter.token, ARBITER_WALLET);
  const created = await call(base, buyer.token, 'POST', '/api/deals', {
    title: 'USDT escrow deal', asset: 'USDT', amount: 250,
    counterpartyEmail: 'seller@example.com', arbiterEmail: 'arbiter@example.com',
  });
  assert.equal(created.status, 201);
  assert.equal(created.payload.item.fundingVerified, false);
  const dealId = created.payload.item.id;

  const bySeller = await call(base, seller.token, 'POST', '/api/deals/' + dealId + '/link-chain', { txHash: TX_HASH });
  assert.equal(bySeller.status, 403);

  const linked = await call(base, buyer.token, 'POST', '/api/deals/' + dealId + '/link-chain', { txHash: TX_HASH });
  assert.equal(linked.status, 200, JSON.stringify(linked.payload));
  assert.equal(linked.payload.item.status, 'funded');
  assert.equal(linked.payload.item.fundingVerified, true);
  assert.equal(linked.payload.item.chainDealId, 7);
  assert.equal(linked.payload.item.fundingTxHash, TX_HASH);
  assert.ok(linked.payload.item.fundedAt);

  const again = await call(base, buyer.token, 'POST', '/api/deals/' + dealId + '/link-chain', { txHash: TX_HASH });
  assert.equal(again.status, 409);

  // The same funding transaction cannot fund a second deal.
  const second = await call(base, buyer.token, 'POST', '/api/deals', {
    title: 'Second USDT deal', asset: 'USDT', amount: 250,
    counterpartyEmail: 'seller@example.com', arbiterEmail: 'arbiter@example.com',
  });
  const reuse = await call(base, buyer.token, 'POST', '/api/deals/' + second.payload.item.id + '/link-chain', { txHash: TX_HASH });
  assert.equal(reuse.status, 409);
});

test('link-chain rejects missing wallets, BNB deals and amount mismatch', async t => {
  const { base, state, buyer, seller, arbiter } = await setupChainDeal(t);
  await setWallet(base, buyer.token, BUYER_WALLET);
  await setWallet(base, seller.token, SELLER_WALLET);
  // arbiter wallet intentionally unset
  const usdt = await call(base, buyer.token, 'POST', '/api/deals', {
    title: 'USDT deal no arbiter wallet', asset: 'USDT', amount: 250,
    counterpartyEmail: 'seller@example.com', arbiterEmail: 'arbiter@example.com',
  });
  const missing = await call(base, buyer.token, 'POST', '/api/deals/' + usdt.payload.item.id + '/link-chain', { txHash: TX_HASH });
  assert.equal(missing.status, 400);
  assert.match(missing.payload.error, /wallet address/);

  const bnb = await call(base, buyer.token, 'POST', '/api/deals', {
    title: 'BNB deal', asset: 'BNB', amount: 1,
    counterpartyEmail: 'seller@example.com', arbiterEmail: 'arbiter@example.com',
  });
  assert.equal(bnb.status, 201);
  const wrongAsset = await call(base, buyer.token, 'POST', '/api/deals/' + bnb.payload.item.id + '/link-chain', { txHash: TX_HASH });
  assert.equal(wrongAsset.status, 400);
  assert.match(wrongAsset.payload.error, /USDT deals/);

  await setWallet(base, arbiter.token, ARBITER_WALLET);
  state.current = fundingTx({ amountUnits: amountToTokenUnits(251) });
  const mismatch = await call(base, buyer.token, 'POST', '/api/deals/' + usdt.payload.item.id + '/link-chain', { txHash: TX_HASH });
  assert.equal(mismatch.status, 400);
  assert.match(mismatch.payload.error, /amount does not match/);
});

test('link-chain is unavailable when the server has no chain configuration', async t => {
  const app = createApp({ tokenSecret: SECRET });
  const base = await withServer(t, app);
  const buyer = await register(base, 'b2@example.com', 'Buyer Two');
  await register(base, 's2@example.com', 'Seller Two');
  await register(base, 'a2@example.com', 'Arbiter Two');
  const created = await call(base, buyer.token, 'POST', '/api/deals', {
    title: 'USDT deal unconfigured', asset: 'USDT', amount: 10,
    counterpartyEmail: 's2@example.com', arbiterEmail: 'a2@example.com',
  });
  assert.equal(created.status, 201);
  const res = await call(base, buyer.token, 'POST', '/api/deals/' + created.payload.item.id + '/link-chain', { txHash: TX_HASH });
  assert.equal(res.status, 503);
});

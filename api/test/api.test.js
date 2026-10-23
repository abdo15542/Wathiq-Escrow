const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

async function withServer(t, app) {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

async function register(base, email = 'person@example.com') {
  const response = await fetch(base + '/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, displayName: 'Test User', password: 'a-long-test-password-123' }),
  });
  assert.equal(response.status, 201);
  return (await response.json()).token;
}

function sendOffer(base, token, body) {
  return fetch(base + '/api/offers', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify(body),
  });
}

const validOffer = (title = 'Buy BNB') => ({
  title, asset: 'BNB', price: 600, paymentMethod: 'bank_transfer',
});

test('health endpoint reports service status', async t => {
  const base = await withServer(t, createApp());
  const response = await fetch(base + '/health');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'ok');
});

test('registers users, hashes passwords, logs in, and exposes authenticated profile', async t => {
  const base = await withServer(t, createApp());
  const response = await fetch(base + '/api/auth/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ' PERSON@example.com ', displayName: 'Person', password: 'a-long-test-password-123' }),
  });
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.user.email, 'person@example.com');
  assert.equal(typeof created.token, 'string');
  assert.equal('password_hash' in created.user, false);

  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'person@example.com', password: 'a-long-test-password-123' }),
  });
  assert.equal(login.status, 200);
  const token = (await login.json()).token;
  const me = await fetch(base + '/api/auth/me', { headers: { authorization: 'Bearer ' + token } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.email, 'person@example.com');
});

test('rejects duplicate registration, weak passwords, and invalid credentials', async t => {
  const base = await withServer(t, createApp());
  const body = { email: 'person@example.com', displayName: 'Person', password: 'a-long-test-password-123' };
  const send = data => fetch(base + '/api/auth/register', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
  });
  assert.equal((await send({ ...body, password: 'short' })).status, 400);
  assert.equal((await send(body)).status, 201);
  assert.equal((await send(body)).status, 409);
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: body.email, password: 'wrong-password-123' }),
  });
  assert.equal(login.status, 401);

  for (const password of [undefined, null, 123, {}, [], 'x'.repeat(201)]) {
    const malformed = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: body.email, password }),
    });
    assert.equal(malformed.status, 401, 'malformed password should be rejected as invalid credentials');
    assert.deepEqual(await malformed.json(), { error: 'invalid email or password' });
  }
});

test('offer creation requires authentication', async t => {
  const base = await withServer(t, createApp());
  const response = await fetch(base + '/api/offers', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validOffer()),
  });
  assert.equal(response.status, 401);
});

test('creates, lists, filters and retrieves authenticated offers', async t => {
  const base = await withServer(t, createApp());
  const token = await register(base);
  const response = await sendOffer(base, token, validOffer());
  assert.equal(response.status, 201);
  const created = (await response.json()).item;
  assert.equal(created.title, 'Buy BNB');
  assert.equal(created.status, 'open');
  assert.ok(created.ownerId > 0);
  const list = await fetch(base + '/api/offers?asset=BNB&limit=10');
  assert.equal((await list.json()).total, 1);
  const get = await fetch(base + '/api/offers/' + created.id);
  assert.equal((await get.json()).item.id, created.id);
});

test('rejects invalid offer data and unknown payment methods', async t => {
  const base = await withServer(t, createApp());
  const token = await register(base);
  const cases = [
    { title: '', asset: 'BNB', price: 1, paymentMethod: 'bank_transfer' },
    { title: 'Buy BNB', asset: 'BTC', price: 1, paymentMethod: 'bank_transfer' },
    { title: 'Buy BNB', asset: 'BNB', price: Infinity, paymentMethod: 'bank_transfer' },
    { title: 'Buy BNB', asset: 'BNB', price: 1, paymentMethod: 'made_up' },
  ];
  for (const body of cases) assert.equal((await sendOffer(base, token, body)).status, 400);
});

test('applies a per-client create rate limit after validation', async t => {
  let clock = 1000;
  const base = await withServer(t, createApp({ now: () => clock, maxCreatesPerMinute: 1 }));
  const token = await register(base);
  assert.equal((await sendOffer(base, token, { ...validOffer(), title: 'x' })).status, 400);
  assert.equal((await sendOffer(base, token, validOffer())).status, 201);
  const limited = await sendOffer(base, token, validOffer('Second offer'));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.deepEqual(await limited.json(), { error: 'rate limit exceeded; try again later' });
  clock += 60_001;
  assert.equal((await sendOffer(base, token, validOffer('Third offer'))).status, 201);
});

test('rate limits offers by the client IP behind the trusted Render proxy', async t => {
  const base = await withServer(t, createApp({ maxCreatesPerMinute: 1 }));
  const token = await register(base);
  const createFrom = (ip, title) => fetch(base + '/api/offers', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + token,
      'x-forwarded-for': ip,
    },
    body: JSON.stringify(validOffer(title)),
  });

  assert.equal((await createFrom('198.51.100.10', 'First from A')).status, 201);
  assert.equal((await createFrom('198.51.100.10', 'Second from A')).status, 429);
  assert.equal((await createFrom('198.51.100.11', 'First from B')).status, 201);
});

test('only the owner can close an offer', async t => {
  const base = await withServer(t, createApp());
  const owner = await register(base, 'owner@example.com');
  const other = await register(base, 'other@example.com');
  const created = await sendOffer(base, owner, validOffer());
  const id = (await created.json()).item.id;
  const denied = await fetch(base + '/api/offers/' + id + '/close', {
    method: 'PATCH', headers: { authorization: 'Bearer ' + other },
  });
  assert.equal(denied.status, 404);
  const closed = await fetch(base + '/api/offers/' + id + '/close', {
    method: 'PATCH', headers: { authorization: 'Bearer ' + owner },
  });
  assert.equal(closed.status, 200);
  assert.equal((await fetch(base + '/api/offers/' + id)).status, 404);
});

test('admin endpoints require an authenticated administrator and expose safe management data', async t => {
  const { signToken } = require('../src/app');
  const users = [
    { id: 1, email: 'admin@example.com', display_name: 'Admin User', role: 'admin', created_at: '2026-01-01T00:00:00.000Z', password_salt: 'salt', password_hash: 'unused' },
    { id: 2, email: 'member@example.com', display_name: 'Member User', role: 'user', created_at: '2026-01-02T00:00:00.000Z', password_salt: 'salt', password_hash: 'unused' },
  ];
  const offers = [
    { id: 1, ownerId: 2, title: 'Open offer', asset: 'BNB', price: 3, paymentMethod: 'cash', status: 'open', createdAt: '2026-01-02T00:00:00.000Z' },
    { id: 2, ownerId: 2, title: 'Closed offer', asset: 'BNB', price: 4, paymentMethod: 'cash', status: 'closed', createdAt: '2026-01-01T00:00:00.000Z' },
  ];
  const secret = 'test-secret-long-enough-for-test-cases';
  const app = createApp({ users, offers, tokenSecret: secret });
  const base = await withServer(t, app);
  const memberToken = signToken({ sub: 2, role: 'user', iat: 1, exp: 9999999999 }, secret);
  const adminToken = signToken({ sub: 1, role: 'admin', iat: 1, exp: 9999999999 }, secret);

  assert.equal((await fetch(base + '/api/admin/overview')).status, 401);
  assert.equal((await fetch(base + '/api/admin/overview', { headers: { authorization: 'Bearer ' + memberToken } })).status, 403);

  const overviewResponse = await fetch(base + '/api/admin/overview', { headers: { authorization: 'Bearer ' + adminToken } });
  assert.equal(overviewResponse.status, 200);
  assert.deepEqual(await overviewResponse.json(), { users: 2, offers: 2, openOffers: 1, closedOffers: 1 });

  const usersResponse = await fetch(base + '/api/admin/users', { headers: { authorization: 'Bearer ' + adminToken } });
  const listedUsers = await usersResponse.json();
  assert.equal(usersResponse.status, 200);
  assert.equal(listedUsers.total, 2);
  assert.equal('password_hash' in listedUsers.items[0], false);

  const offersResponse = await fetch(base + '/api/admin/offers?status=open', { headers: { authorization: 'Bearer ' + adminToken } });
  assert.equal((await offersResponse.json()).total, 1);

  const closeResponse = await fetch(base + '/api/admin/offers/1/close', { method: 'PATCH', headers: { authorization: 'Bearer ' + adminToken } });
  assert.equal(closeResponse.status, 200);
  assert.equal(offers[0].status, 'closed');
});

test('returns 404 for unknown offers', async t => {
  const base = await withServer(t, createApp());
  assert.equal((await fetch(base + '/api/offers/99')).status, 404);
});

test('returns 413 for request bodies larger than the configured limit', async t => {
  const base = await withServer(t, createApp());
  const response = await fetch(base + '/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ padding: 'x'.repeat(33 * 1024) }),
  });
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /too large/i);
});

test('authenticated users can list only their own offers, including closed offers', async t => {
  const base = await withServer(t, createApp());
  const ownerToken = await register(base, 'owner-list@example.com');
  const otherToken = await register(base, 'other-list@example.com');
  const own = await sendOffer(base, ownerToken, validOffer('My offer'));
  const other = await sendOffer(base, otherToken, validOffer('Other offer'));
  assert.equal(own.status, 201);
  assert.equal(other.status, 201);
  const ownId = (await own.json()).item.id;
  assert.equal((await fetch(base + '/api/offers/' + ownId + '/close', {
    method: 'PATCH', headers: { authorization: 'Bearer ' + ownerToken },
  })).status, 200);

  const unauthorized = await fetch(base + '/api/my/offers');
  assert.equal(unauthorized.status, 401);
  const response = await fetch(base + '/api/my/offers?limit=10', {
    headers: { authorization: 'Bearer ' + ownerToken },
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.total, 1);
  assert.equal(data.items[0].title, 'My offer');
  assert.equal(data.items[0].status, 'closed');
  assert.equal(data.items[0].ownerId, 1);
});


test('rejects tampered and expired bearer tokens', async t => {
  let clock = Date.UTC(2026, 0, 1, 0, 0, 0);
  const base = await withServer(t, createApp({ now: () => clock }));
  const token = await register(base, 'token-lifecycle@example.com');

  const valid = await fetch(base + '/api/auth/me', {
    headers: { authorization: 'Bearer ' + token },
  });
  assert.equal(valid.status, 200);

  const parts = token.split('.');
  parts[1] = Buffer.from(JSON.stringify({ sub: 999, role: 'admin', iat: 1, exp: 9999999999 })).toString('base64url');
  const tampered = await fetch(base + '/api/auth/me', {
    headers: { authorization: 'Bearer ' + parts.join('.') },
  });
  assert.equal(tampered.status, 401);

  clock += 8 * 24 * 60 * 60 * 1000;
  const expired = await fetch(base + '/api/auth/me', {
    headers: { authorization: 'Bearer ' + token },
  });
  assert.equal(expired.status, 401);
});

test('limits authentication attempts per client and resets after the window', async t => {
  let clock = 10_000;
  const base = await withServer(t, createApp({ now: () => clock }));
  await register(base, 'rate-limit-auth@example.com');

  const attempt = () => fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'rate-limit-auth@example.com', password: 'wrong-password-123' }),
  });

  // Registration plus nine login attempts reaches ten attempts in the 15-minute window.
  for (let i = 0; i < 9; i += 1) assert.equal((await attempt()).status, 401);
  assert.equal((await attempt()).status, 429);
  clock += 15 * 60_000 + 1;
  assert.equal((await attempt()).status, 401);
});


test('rejects bearer tokens that declare a different signing algorithm even with a valid HMAC', async t => {
  const crypto = require('node:crypto');
  const { signToken } = require('../src/app');
  const secret = 'test-secret-long-enough-for-algorithm-check';
  const base = await withServer(t, createApp({ tokenSecret: secret }));
  const payload = { sub: 1, role: 'admin', iat: 1, exp: 9999999999 };
  const valid = signToken(payload, secret);
  const [header, body] = valid.split('.');
  const forgedHeader = Buffer.from(JSON.stringify({ alg: 'HS512', typ: 'JWT' })).toString('base64url');
  const unsigned = forgedHeader + '.' + body;
  const signature = crypto.createHmac('sha256', secret).update(unsigned).digest('base64url');
  const wrongAlgorithm = unsigned + '.' + signature;

  for (const token of [wrongAlgorithm, valid + '!', 'a.b.c', 'x'.repeat(8193)]) {
    const response = await fetch(base + '/api/auth/me', {
      headers: { authorization: 'Bearer ' + token },
    });
    assert.equal(response.status, 401);
  }
});
 
test('pagination offsets reject malformed and unsafe values instead of silently normalizing them', async t => {
  const base = await withServer(t, createApp());

  for (const offset of ['999999999999999999999999999999999999', 'not-a-number', '-1', '1.5']) {
    const response = await fetch(base + '/api/offers?offset=' + encodeURIComponent(offset));
    assert.equal(response.status, 400, 'invalid offset should be rejected: ' + offset);
    assert.deepEqual(await response.json(), {
      error: 'limit must be 1-50 and offset must be 0-1000000 integers',
    });
  }

  const cappedBoundary = await fetch(base + '/api/offers?offset=1000000');
  assert.equal(cappedBoundary.status, 200);
  assert.equal((await cappedBoundary.json()).offset, 1000000);
});


test('health readiness confirms PostgreSQL connectivity and hides database errors', async t => {
  const unavailablePool = {
    query: async () => { throw new Error('sensitive connection details must not leak'); },
  };
  const unavailableBase = await withServer(t, createApp({ pool: unavailablePool }));
  const unavailable = await fetch(unavailableBase + '/health');
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), {
    status: 'error',
    service: 'wathiq-api',
    database: 'unavailable',
  });

  const connectedPool = {
    query: async () => ({ rows: [{ '?column?': 1 }] }),
  };
  const connectedBase = await withServer(t, createApp({ pool: connectedPool }));
  const connected = await fetch(connectedBase + '/health');
  assert.equal(connected.status, 200);
  assert.deepEqual(await connected.json(), {
    status: 'ok',
    service: 'wathiq-api',
    database: 'connected',
  });
});

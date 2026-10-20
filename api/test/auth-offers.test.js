const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

async function withServer(t, app) {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

async function register(base, email, displayName = 'Test User', password = 'long-password-123') {
  return fetch(base + '/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, displayName, password }),
  });
}

test('registration, login, and /me return a safe user and valid bearer token', async t => {
  const base = await withServer(t, createApp({
    tokenSecret: 'test-secret-long-enough-for-auth-flow-tests',
  }));

  const created = await register(base, '  PERSON@example.com  ');
  assert.equal(created.status, 201);
  const payload = await created.json();
  assert.equal(payload.user.email, 'person@example.com');
  assert.equal(payload.user.displayName, 'Test User');
  assert.equal(payload.user.role, 'user');
  assert.equal(typeof payload.token, 'string');
  assert.equal(payload.tokenType, 'Bearer');
  assert.equal('password_hash' in payload.user, false);
  assert.equal('password_salt' in payload.user, false);

  const login = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'PERSON@example.com', password: 'long-password-123' }),
  });
  assert.equal(login.status, 200);
  const loggedIn = await login.json();
  assert.equal(loggedIn.user.id, payload.user.id);

  const me = await fetch(base + '/api/auth/me', {
    headers: { authorization: 'Bearer ' + loggedIn.token },
  });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.email, 'person@example.com');
});

test('registration rejects duplicate emails and weak passwords', async t => {
  const base = await withServer(t, createApp({
    tokenSecret: 'test-secret-long-enough-for-auth-flow-tests',
  }));
  assert.equal((await register(base, 'same@example.com')).status, 201);
  assert.equal((await register(base, 'SAME@example.com')).status, 409);
  assert.equal((await register(base, 'other@example.com', 'Valid Name', 'short')).status, 400);
});

test('login safely rejects malformed credentials and incorrect passwords', async t => {
  const base = await withServer(t, createApp({
    tokenSecret: 'test-secret-long-enough-for-auth-flow-tests',
  }));
  await register(base, 'login@example.com');
  for (const body of [
    { email: 'login@example.com', password: 'wrong-password' },
    { email: 'login@example.com', password: 123 },
    { email: 'login@example.com', password: 'x'.repeat(201) },
  ]) {
    const response = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'invalid email or password' });
  }
});

test('offers require authentication and owners cannot close another account\'s offer', async t => {
  const base = await withServer(t, createApp({
    tokenSecret: 'test-secret-long-enough-for-auth-flow-tests',
  }));
  const first = await (await register(base, 'first@example.com', 'First User')).json();
  const second = await (await register(base, 'second@example.com', 'Second User')).json();

  const anonymousCreate = await fetch(base + '/api/offers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Offer title', asset: 'BNB', price: 2, paymentMethod: 'cash' }),
  });
  assert.equal(anonymousCreate.status, 401);

  for (const invalidPrice of [0.00000000001, 1.123456789012, 0, -1, '2']) {
    const invalid = await fetch(base + '/api/offers', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + first.token,
      },
      body: JSON.stringify({ title: 'Offer title', asset: 'BNB', price: invalidPrice, paymentMethod: 'cash' }),
    });
    assert.equal(invalid.status, 400);
  }

  const created = await fetch(base + '/api/offers', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + first.token,
    },
    body: JSON.stringify({ title: 'Offer title', asset: 'BNB', price: 1.1234567891, paymentMethod: 'cash' }),
  });
  assert.equal(created.status, 201);
  const offer = (await created.json()).item;
  assert.equal(offer.ownerId, first.user.id);

  const forbiddenClose = await fetch(base + '/api/offers/' + offer.id + '/close', {
    method: 'PATCH',
    headers: { authorization: 'Bearer ' + second.token },
  });
  assert.equal(forbiddenClose.status, 404);

  const ownerClose = await fetch(base + '/api/offers/' + offer.id + '/close', {
    method: 'PATCH',
    headers: { authorization: 'Bearer ' + first.token },
  });
  assert.equal(ownerClose.status, 200);

  const mine = await fetch(base + '/api/my/offers', {
    headers: { authorization: 'Bearer ' + first.token },
  });
  const minePayload = await mine.json();
  assert.equal(minePayload.total, 1);
  assert.equal(minePayload.items[0].status, 'closed');
});

test('admin authorization is read from the account record, not trusted from the token role', async t => {
  const users = [{
    id: 1,
    email: 'user@example.com',
    display_name: 'Normal User',
    role: 'user',
    password_salt: 'not-used',
    password_hash: 'not-used',
    created_at: new Date().toISOString(),
  }];
  const { signToken } = require('../src/app');
  const secret = 'test-secret-long-enough-for-auth-flow-tests';
  const token = signToken({
    sub: 1,
    role: 'admin',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60,
  }, secret);
  const base = await withServer(t, createApp({ users, tokenSecret: secret }));
  const response = await fetch(base + '/api/admin/overview', {
    headers: { authorization: 'Bearer ' + token },
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'administrator access required' });
});

test('offer route IDs reject partial, decimal, zero, and unsafe integer strings', async t => {
  const base = await withServer(t, createApp());
  for (const id of ['1abc', '1.5', '0', '-1', '9007199254740992']) {
    const response = await fetch(base + '/api/offers/' + id);
    assert.equal(response.status, 400, 'expected invalid ID rejection for ' + id);
    assert.deepEqual(await response.json(), { error: 'invalid offer id' });
  }
  const missing = await fetch(base + '/api/offers/1');
  assert.equal(missing.status, 404, 'a valid positive ID should reach lookup');

  const registered = await register(base, 'route-id@example.com');
  const { token } = await registered.json();
  const malformedClose = await fetch(base + '/api/offers/1abc/close', {
    method: 'PATCH',
    headers: { authorization: 'Bearer ' + token },
  });
  assert.equal(malformedClose.status, 400);
  assert.deepEqual(await malformedClose.json(), { error: 'invalid offer id' });
});

test('offer pagination rejects malformed and out-of-range query parameters', async t => {
  const base = await withServer(t, createApp());
  for (const query of [
    'limit=1abc', 'limit=1.5', 'limit=0', 'limit=51',
    'offset=-1', 'offset=1.2', 'offset=1abc', 'offset=1000001',
  ]) {
    const response = await fetch(base + '/api/offers?' + query);
    assert.equal(response.status, 400, 'expected invalid pagination rejection for ' + query);
    assert.deepEqual(await response.json(), {
      error: 'limit must be 1-50 and offset must be 0-1000000 integers',
    });
  }
  const valid = await fetch(base + '/api/offers?limit=10&offset=0');
  assert.equal(valid.status, 200);
  const payload = await valid.json();
  assert.equal(payload.limit, 10);
  assert.equal(payload.offset, 0);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

async function withServer(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

test('authentication endpoints throttle repeated attempts from the same client', async t => {
  const base = await withServer(t, createApp({
    tokenSecret: 'test-secret-long-enough-for-rate-limit-tests',
  }));
  const statuses = [];
  for (let i = 0; i < 11; i += 1) {
    const response = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'missing@example.com', password: 'incorrect-password' }),
    });
    statuses.push(response.status);
    await response.arrayBuffer();
  }
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
  assert.equal(statuses[10], 429);
});

test('API rejects oversized JSON bodies with a stable 413 response', async t => {
  const base = await withServer(t, createApp());
  const response = await fetch(base + '/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'large@example.com',
      displayName: 'Large Payload',
      password: 'safe-password-123',
      extra: 'x'.repeat(40 * 1024),
    }),
  });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {
    error: 'request body too large; maximum is 32kb',
  });
});

test('registration validates email and display name without creating a user', async t => {
  const base = await withServer(t, createApp({
    tokenSecret: 'test-secret-long-enough-for-validation-tests',
  }));
  const invalidBodies = [
    { email: 'not-an-email', displayName: 'Valid Name', password: 'valid-password-123' },
    { email: 'valid@example.com', displayName: 'x', password: 'valid-password-123' },
    { email: 'valid@example.com', displayName: 'x'.repeat(81), password: 'valid-password-123' },
  ];
  for (const body of invalidBodies) {
    const response = await fetch(base + '/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
  }
});

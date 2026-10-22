const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

async function withServer(t, app) {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

async function register(base, email = 'admin-check@example.com') {
  const response = await fetch(base + '/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      displayName: 'Admin Check',
      password: 'a-long-test-password-123',
    }),
  });
  assert.equal(response.status, 201);
  return (await response.json()).token;
}

test('admin endpoints require a current database role, not the role embedded in a token', async t => {
  const users = [];
  const base = await withServer(t, createApp({ users }));
  const token = await register(base);
  const headers = { authorization: 'Bearer ' + token };

  const unauthenticated = await fetch(base + '/api/admin/overview');
  assert.equal(unauthenticated.status, 401);

  const ordinaryUser = await fetch(base + '/api/admin/overview', { headers });
  assert.equal(ordinaryUser.status, 403);

  // Simulate a trusted out-of-band promotion without issuing a new token.
  users[0].role = 'admin';
  const promoted = await fetch(base + '/api/admin/overview', { headers });
  assert.equal(promoted.status, 200);
  assert.equal((await promoted.json()).users, 1);

  // Demotion must take effect immediately even while the old token is still valid.
  users[0].role = 'user';
  const demoted = await fetch(base + '/api/admin/overview', { headers });
  assert.equal(demoted.status, 403);
});

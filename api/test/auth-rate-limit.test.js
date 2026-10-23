const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

async function withServer(t, app) {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

test('authentication endpoints throttle repeated attempts and return Retry-After', async t => {
  let currentTime = 1_800_000_000_000;
  const base = await withServer(t, createApp({
    tokenSecret: 'test-secret-long-enough-for-rate-limit-tests',
    now: () => currentTime,
  }));

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'missing@example.com', password: 123 }),
    });
    assert.equal(response.status, 401, 'attempt ' + (attempt + 1) + ' should be allowed');
  }

  const limited = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'missing@example.com', password: 'incorrect-password' }),
  });
  assert.equal(limited.status, 429);
  assert.match(limited.headers.get('retry-after') || '', /^[1-9][0-9]*$/);
  assert.deepEqual(await limited.json(), {
    error: 'too many authentication attempts; try again in 15 minutes',
  });

  // The rate limit is a rolling fixed window; a new window permits attempts again.
  currentTime += 15 * 60_000;
  const afterWindow = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'missing@example.com', password: 123 }),
  });
  assert.equal(afterWindow.status, 401);
});

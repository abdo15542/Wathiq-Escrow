const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

function withEnv(values, fn) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { return fn(); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withServer(t, app) {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

test('production configuration fails closed without a database', () => {
  withEnv({ NODE_ENV: 'production', DATABASE_URL: undefined, JWT_SECRET: 'a'.repeat(40) }, () => {
    assert.throws(() => createApp(), /DATABASE_URL is required in production/);
  });
});

test('production configuration rejects a weak signing secret', () => {
  withEnv({ NODE_ENV: 'production', JWT_SECRET: 'too-short' }, () => {
    assert.throws(() => createApp({ pool: { query: async () => ({ rows: [] }) } }), /JWT_SECRET must be at least 32 characters/);
  });
});

test('health endpoint reports database outage instead of healthy status', async t => {
  const base = await withServer(t, createApp({
    pool: { query: async () => { throw new Error('simulated database outage'); } },
    tokenSecret: 'test-secret-long-enough-for-production-config-tests',
  }));
  const response = await fetch(base + '/health');
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    status: 'error',
    service: 'wathiq-api',
    database: 'unavailable',
  });
});

test('API responses include security headers and malformed JSON is a client error', async t => {
  const base = await withServer(t, createApp());
  const health = await fetch(base + '/health');
  assert.equal(health.status, 200);
  assert.ok(health.headers.get('x-content-type-options'));
  assert.ok(health.headers.get('x-frame-options'));

  const malformed = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"email":',
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'invalid request body' });
});

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createApp } = require('../src/app');
const { createPoolOptions } = require('../src/db-config');

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


test('authentication rejects a correctly signed token that declares an unexpected algorithm', async t => {
  const secret = 'test-secret-long-enough-for-jwt-algorithm-tests';
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = encode({ alg: 'none', typ: 'JWT' }) + '.' +
    encode({ sub: 1, exp: Math.floor(Date.now() / 1000) + 60 });
  // Sign it with the API secret deliberately: only the header algorithm is invalid.
  const signature = crypto.createHmac('sha256', secret).update(unsigned).digest('base64url');
  const token = unsigned + '.' + signature;
  const base = await withServer(t, createApp({ tokenSecret: secret }));
  const response = await fetch(base + '/api/auth/me', {
    headers: { authorization: 'Bearer ' + token },
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'authentication required' });

  const oversized = await fetch(base + '/api/auth/me', {
    headers: { authorization: 'Bearer ' + 'a'.repeat(9000) },
  });
  assert.equal(oversized.status, 401);
  assert.deepEqual(await oversized.json(), { error: 'authentication required' });
});

test('PostgreSQL connections verify TLS certificates by default', () => {
  const options = createPoolOptions({ DATABASE_URL: 'postgres://example', PGPOOL_MAX: '8' });
  assert.deepEqual(options.ssl, { rejectUnauthorized: true });
  assert.equal(options.max, 8);
  assert.equal(options.connectionTimeoutMillis, 10000);
  assert.equal(options.statement_timeout, 10000);
  assert.equal(options.query_timeout, 12000);
  assert.equal(options.idle_in_transaction_session_timeout, 15000);
  assert.equal(options.application_name, 'wathiq-api');
});

test('PostgreSQL TLS can only be disabled with an explicit setting and pool size is bounded', () => {
  assert.equal(createPoolOptions({ PGSSLMODE: 'disable' }).ssl, false);
  assert.throws(() => createPoolOptions({ NODE_ENV: 'production', PGSSLMODE: 'disable' }), /cannot be disabled in production/);
  assert.equal(createPoolOptions({ PGPOOL_MAX: '0' }).max, 10);
  assert.equal(createPoolOptions({ PGPOOL_MAX: '999' }).max, 10);
  assert.equal(createPoolOptions({ PGPOOL_MAX: 'not-a-number' }).max, 10);
});

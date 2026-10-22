const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

async function withServer(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  return 'http://127.0.0.1:' + server.address().port;
}

test('health endpoint reports ready only when PostgreSQL responds', async t => {
  let calls = 0;
  const pool = {
    async query(sql) {
      calls += 1;
      assert.equal(sql, 'SELECT 1');
      return { rows: [{ '?column?': 1 }] };
    },
  };
  const base = await withServer(t, createApp({ pool, tokenSecret: 'health-test-secret-at-least-32-chars' }));
  const response = await fetch(base + '/health');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: 'ok',
    service: 'wathiq-api',
    database: 'connected',
  });
  assert.equal(calls, 1);
});

test('health endpoint returns 503 without exposing database errors when PostgreSQL is unavailable', async t => {
  const pool = {
    async query() {
      throw new Error('sensitive database connection detail');
    },
  };
  const base = await withServer(t, createApp({ pool, tokenSecret: 'health-test-secret-at-least-32-chars' }));
  const response = await fetch(base + '/health');
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    status: 'error',
    service: 'wathiq-api',
    database: 'unavailable',
  });
});

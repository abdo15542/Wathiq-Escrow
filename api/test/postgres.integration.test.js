const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createApp, ensureSchema } = require('../src/app');

test('PostgreSQL keeps accounts and offers after the API app is recreated', {
  skip: !process.env.DATABASE_URL && 'DATABASE_URL is not configured; PostgreSQL integration test runs in CI',
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 5000 });
  let server;
  try {
    await pool.query('SELECT 1');
    await ensureSchema(pool);
    // Isolated CI database: clear only this application's test tables.
    await pool.query('TRUNCATE TABLE wathiq_offers, wathiq_users RESTART IDENTITY CASCADE');

    const tokenSecret = 'postgres-integration-test-secret-at-least-32-characters';
    const startServer = async () => {
      const app = createApp({ pool, tokenSecret });
      server = app.listen(0);
      await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
      return 'http://127.0.0.1:' + server.address().port;
    };
    const stopServer = async () => {
      if (!server) return;
      const current = server;
      server = null;
      await new Promise((resolve, reject) => current.close(error => error ? reject(error) : resolve()));
    };

    const email = 'persist-' + process.pid + '-' + Date.now() + '@example.test';
    const firstBase = await startServer();
    const registration = await fetch(firstBase + '/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, displayName: 'Persistence Test', password: 'test-password-longer-than-ten' }),
    });
    assert.equal(registration.status, 201);
    const registered = await registration.json();

    const created = await fetch(firstBase + '/api/offers', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + registered.token },
      body: JSON.stringify({ title: 'Persistent offer', asset: 'BNB', price: 12.5, paymentMethod: 'bank_transfer' }),
    });
    assert.equal(created.status, 201);
    const offer = (await created.json()).item;
    assert.equal(offer.ownerId, registered.user.id);
    await stopServer();

    const secondBase = await startServer();
    const login = await fetch(secondBase + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'test-password-longer-than-ten' }),
    });
    assert.equal(login.status, 200, 'the account must survive API restart');
    const loggedIn = await login.json();

    const list = await fetch(secondBase + '/api/offers?asset=BNB', {
      headers: { authorization: 'Bearer ' + loggedIn.token },
    });
    assert.equal(list.status, 200);
    const listed = await list.json();
    assert.equal(listed.total, 1, 'the offer must survive API restart');
    assert.equal(listed.items[0].id, offer.id);
    assert.equal(listed.items[0].title, 'Persistent offer');
    assert.equal(listed.items[0].ownerId, registered.user.id);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await pool.query('TRUNCATE TABLE wathiq_offers, wathiq_users RESTART IDENTITY CASCADE').catch(() => {});
    await pool.end();
  }
});

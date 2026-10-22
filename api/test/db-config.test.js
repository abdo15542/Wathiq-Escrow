const test = require('node:test');
const assert = require('node:assert/strict');
const { createPoolOptions } = require('../src/db-config');

test('uses strict certificate verification by default', () => {
  const options = createPoolOptions({ DATABASE_URL: 'postgres://example', NODE_ENV: 'production' });
  assert.deepEqual(options.ssl, { rejectUnauthorized: true });
  assert.equal(options.connectionString, 'postgres://example');
});

test('supports an explicit CA certificate with strict verification', () => {
  const options = createPoolOptions({
    DATABASE_URL: 'postgres://example',
    NODE_ENV: 'production',
    PGSSL_CA_CERT: 'test-ca-certificate',
  });
  assert.deepEqual(options.ssl, { rejectUnauthorized: true, ca: 'test-ca-certificate' });
});

test('allows encrypted connections for providers requiring TLS without public CA validation', () => {
  const options = createPoolOptions({
    DATABASE_URL: 'postgres://example',
    NODE_ENV: 'production',
    PGSSLMODE: 'require',
  });
  assert.deepEqual(options.ssl, { rejectUnauthorized: false });
});

test('refuses to disable PostgreSQL TLS in production', () => {
  assert.throws(
    () => createPoolOptions({
      DATABASE_URL: 'postgres://example',
      NODE_ENV: 'production',
      PGSSLMODE: 'disable',
    }),
    /PostgreSQL TLS cannot be disabled in production/,
  );
});

test('bounds pool size and configures query timeouts', () => {
  const options = createPoolOptions({
    DATABASE_URL: 'postgres://example',
    PGPOOL_MAX: '4',
  });
  assert.equal(options.max, 4);
  assert.equal(options.connectionTimeoutMillis, 10000);
  assert.equal(options.statement_timeout, 10000);
  assert.equal(options.query_timeout, 12000);
  assert.equal(options.idle_in_transaction_session_timeout, 15000);

  assert.equal(createPoolOptions({ PGPOOL_MAX: '0' }).max, 10);
  assert.equal(createPoolOptions({ PGPOOL_MAX: '101' }).max, 10);
});

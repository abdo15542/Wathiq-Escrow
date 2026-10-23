const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureSchema } = require('../src/app');

test('schema setup creates indexes for owner and status offer listings', async () => {
  const statements = [];
  const pool = {
    query: async sql => {
      statements.push(sql);
      return { rows: [] };
    },
  };

  await ensureSchema(pool);
  const schemaSql = statements.join('\n');

  assert.match(schemaSql, /CREATE INDEX IF NOT EXISTS wathiq_offers_owner_created_idx ON wathiq_offers \(owner_id, created_at DESC\)/);
  assert.match(schemaSql, /CREATE INDEX IF NOT EXISTS wathiq_offers_status_created_idx ON wathiq_offers \(status, created_at DESC\)/);
});

test('offer-listing indexes are safe to ensure repeatedly', async () => {
  const statements = [];
  const pool = {
    query: async sql => {
      statements.push(sql);
      return { rows: [] };
    },
  };

  await ensureSchema(pool);
  await ensureSchema(pool);

  const schemaSql = statements.join('\n');
  assert.equal((schemaSql.match(/CREATE INDEX IF NOT EXISTS wathiq_offers_owner_created_idx/g) || []).length, 2);
  assert.equal((schemaSql.match(/CREATE INDEX IF NOT EXISTS wathiq_offers_status_created_idx/g) || []).length, 2);
});

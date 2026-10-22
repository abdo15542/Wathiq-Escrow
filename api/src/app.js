const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { Pool } = require('pg');

const ALLOWED_ASSETS = new Set(['BNB']);
const ALLOWED_PAYMENT_METHODS = new Set(['bank_transfer', 'cash', 'crypto', 'digital_service', 'gift_card']);

function createApp(options = {}) {
  const app = express();
  const memoryOffers = options.offers || [];
  const useMemory = Array.isArray(options.offers) || options.database === false;
  const pool = options.pool || (!useMemory && process.env.DATABASE_URL
    ? new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
        max: Number(process.env.DB_POOL_MAX || 5),
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30000,
      })
    : null);
  const createWindow = new Map();
  const now = options.now || (() => Date.now());
  const maxCreatesPerMinute = options.maxCreatesPerMinute ?? 20;
  let schemaReady = Promise.resolve();

  if (pool) {
    schemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS offers (
        id BIGSERIAL PRIMARY KEY,
        title VARCHAR(100) NOT NULL CHECK (char_length(title) >= 3),
        asset VARCHAR(12) NOT NULL CHECK (asset = 'BNB'),
        price NUMERIC(20, 8) NOT NULL CHECK (price > 0),
        payment_method VARCHAR(32) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        status VARCHAR(20) NOT NULL DEFAULT 'draft'
      );
      CREATE INDEX IF NOT EXISTS offers_asset_created_idx ON offers (asset, created_at DESC);
    `);
  }

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:4173' }));
  app.use(express.json({ limit: '32kb', strict: true }));

  app.get('/health', async (_req, res) => {
    try {
      await schemaReady;
      if (pool) await pool.query('SELECT 1');
      res.json({
        status: 'ok',
        service: 'wathiq-api',
        mode: process.env.NODE_ENV || 'development',
        persistence: pool ? 'postgresql' : 'memory',
        database: pool ? 'connected' : 'not_configured'
      });
    } catch (_error) {
      res.status(503).json({ status: 'error', service: 'wathiq-api', database: 'unavailable' });
    }
  });

  app.get('/api/offers', async (req, res) => {
    try {
      await schemaReady;
      const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
      const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
      const asset = typeof req.query.asset === 'string' ? req.query.asset.toUpperCase() : null;
      if (pool) {
        const values = asset ? [asset, limit, offset] : [limit, offset];
        const where = asset ? 'WHERE asset = $1' : '';
        const limitPos = asset ? '$2' : '$1';
        const offsetPos = asset ? '$3' : '$2';
        const [items, count] = await Promise.all([
          pool.query(`SELECT id, title, asset, price::float8 AS price, payment_method AS "paymentMethod", created_at AS "createdAt", status FROM offers ${where} ORDER BY created_at DESC, id DESC LIMIT ${limitPos} OFFSET ${offsetPos}`, values),
          pool.query(`SELECT COUNT(*)::int AS total FROM offers ${where}`, asset ? [asset] : [])
        ]);
        return res.json({ items: items.rows, total: count.rows[0].total, limit, offset });
      }
      const filtered = asset ? memoryOffers.filter(item => item.asset === asset) : memoryOffers;
      return res.json({ items: filtered.slice(offset, offset + limit), total: filtered.length, limit, offset });
    } catch (_error) {
      return res.status(503).json({ error: 'offers storage unavailable' });
    }
  });

  app.get('/api/offers/:id', async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'invalid offer id' });
    try {
      await schemaReady;
      if (pool) {
        const result = await pool.query('SELECT id, title, asset, price::float8 AS price, payment_method AS "paymentMethod", created_at AS "createdAt", status FROM offers WHERE id = $1', [id]);
        if (!result.rowCount) return res.status(404).json({ error: 'offer not found' });
        return res.json({ item: result.rows[0] });
      }
      const offer = memoryOffers.find(item => item.id === id);
      if (!offer) return res.status(404).json({ error: 'offer not found' });
      return res.json({ item: offer });
    } catch (_error) {
      return res.status(503).json({ error: 'offers storage unavailable' });
    }
  });

  app.post('/api/offers', async (req, res) => {
    const clientKey = req.ip || req.socket.remoteAddress || 'unknown';
    const current = now();
    const previous = createWindow.get(clientKey);
    if (previous && current - previous.startedAt < 60_000 && previous.count >= maxCreatesPerMinute) {
      return res.status(429).json({ error: 'rate limit exceeded; try again later' });
    }
    if (!previous || current - previous.startedAt >= 60_000) createWindow.set(clientKey, { startedAt: current, count: 1 });
    else previous.count += 1;

    const body = req.body || {};
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const asset = typeof body.asset === 'string' ? body.asset.toUpperCase() : '';
    const paymentMethod = typeof body.paymentMethod === 'string' ? body.paymentMethod : '';
    const price = body.price;
    if (title.length < 3 || title.length > 100) return res.status(400).json({ error: 'title must be 3-100 characters' });
    if (!ALLOWED_ASSETS.has(asset)) return res.status(400).json({ error: 'unsupported asset; MVP supports BNB only' });
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0 || price > 1_000_000_000) {
      return res.status(400).json({ error: 'price must be a positive finite number within supported limits' });
    }
    if (!ALLOWED_PAYMENT_METHODS.has(paymentMethod)) return res.status(400).json({ error: 'unsupported paymentMethod' });

    try {
      await schemaReady;
      if (pool) {
        const result = await pool.query(
          'INSERT INTO offers (title, asset, price, payment_method, status) VALUES ($1, $2, $3, $4, $5) RETURNING id, title, asset, price::float8 AS price, payment_method AS "paymentMethod", created_at AS "createdAt", status',
          [title, asset, price, paymentMethod, 'draft']
        );
        return res.status(201).json({ item: result.rows[0] });
      }
      const offer = {
        id: memoryOffers.reduce((max, item) => Math.max(max, item.id), 0) + 1,
        title, asset, price, paymentMethod,
        createdAt: new Date(current).toISOString(),
        status: 'draft',
      };
      memoryOffers.push(offer);
      return res.status(201).json({ item: offer });
    } catch (_error) {
      return res.status(503).json({ error: 'offers storage unavailable' });
    }
  });

  app.use((err, _req, res, _next) => {
    if (err instanceof SyntaxError || err.status === 400) return res.status(400).json({ error: 'invalid request body' });
    return res.status(500).json({ error: 'internal server error' });
  });
  return app;
}

module.exports = { createApp };

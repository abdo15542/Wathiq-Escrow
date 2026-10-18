const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const crypto = require('node:crypto');

const ALLOWED_ASSETS = new Set(['BNB']);
const ALLOWED_PAYMENT_METHODS = new Set(['bank_transfer', 'cash', 'crypto', 'digital_service', 'gift_card']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7;

function b64url(value) { return Buffer.from(value).toString('base64url'); }
function signToken(payload, secret) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const unsigned = header + '.' + body;
  return unsigned + '.' + crypto.createHmac('sha256', secret).update(unsigned).digest('base64url');
}
function verifyToken(token, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const unsigned = parts[0] + '.' + parts[1];
  const expected = crypto.createHmac('sha256', secret).update(unsigned).digest();
  let actual;
  try { actual = Buffer.from(parts[2], 'base64url'); } catch { return null; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!Number.isInteger(payload.sub) || !Number.isInteger(payload.exp) || payload.exp <= nowSeconds) return null;
    return payload;
  } catch { return null; }
}
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function verifyPassword(password, salt, expectedHex) {
  const actual = crypto.scryptSync(password, salt, 64);
  let expected;
  try { expected = Buffer.from(expectedHex, 'hex'); } catch { return false; }
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}

async function ensureSchema(pool) {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS wathiq_users (' +
    'id BIGSERIAL PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, ' +
    'password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, ' +
    "role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());" +
    'CREATE TABLE IF NOT EXISTS wathiq_offers (' +
    'id BIGSERIAL PRIMARY KEY, owner_id BIGINT REFERENCES wathiq_users(id) ON DELETE SET NULL, ' +
    'title VARCHAR(100) NOT NULL CHECK (char_length(title) BETWEEN 3 AND 100), ' +
    "asset TEXT NOT NULL CHECK (asset = 'BNB'), price NUMERIC(30, 10) NOT NULL CHECK (price > 0), " +
    "payment_method TEXT NOT NULL CHECK (payment_method IN ('bank_transfer','cash','crypto','digital_service','gift_card')), " +
    "status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());" +
    'CREATE INDEX IF NOT EXISTS wathiq_offers_created_idx ON wathiq_offers (created_at DESC);' +
    'CREATE INDEX IF NOT EXISTS wathiq_offers_asset_status_idx ON wathiq_offers (asset, status);'
  );
}

function createApp(options = {}) {
  const app = express();
  const offers = options.offers || [];
  const users = options.users || [];
  const createWindow = new Map();
  const authWindow = new Map();
  const now = options.now || (() => Date.now());
  const maxCreatesPerMinute = options.maxCreatesPerMinute ?? 20;
  const pool = options.pool || null;
  const production = process.env.NODE_ENV === 'production';
  const tokenSecret = options.tokenSecret || process.env.JWT_SECRET || (production ? '' : 'development-only-secret-change-me');
  if (production && !pool) throw new Error('DATABASE_URL is required in production');
  if (production && tokenSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters in production');

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:4173', methods: ['GET', 'POST', 'PATCH', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
  app.use(express.json({ limit: '32kb', strict: true }));

  const userFromRow = row => ({ id: Number(row.id), email: row.email, displayName: row.display_name, role: row.role, createdAt: new Date(row.created_at).toISOString() });
  async function findUserByEmail(email) {
    if (pool) { const result = await pool.query('SELECT * FROM wathiq_users WHERE email = $1', [email]); return result.rows[0] || null; }
    return users.find(user => user.email === email) || null;
  }
  async function findUserById(id) {
    if (pool) { const result = await pool.query('SELECT id,email,display_name,role,created_at FROM wathiq_users WHERE id = $1', [id]); return result.rows[0] || null; }
    return users.find(user => user.id === id) || null;
  }
  async function createUser({ email, displayName, password }) {
    const credentials = hashPassword(password);
    if (pool) {
      const result = await pool.query('INSERT INTO wathiq_users (email,display_name,password_salt,password_hash) VALUES ($1,$2,$3,$4) RETURNING id,email,display_name,role,created_at', [email, displayName, credentials.salt, credentials.hash]);
      return result.rows[0];
    }
    const user = { id: users.reduce((max, item) => Math.max(max, item.id), 0) + 1, email, display_name: displayName, role: 'user', password_salt: credentials.salt, password_hash: credentials.hash, created_at: new Date(now()).toISOString() };
    users.push(user);
    return user;
  }
  async function listOffers({ limit, offset, asset }) {
    if (pool) {
      const where = asset ? 'WHERE asset = $3 AND status = $4' : 'WHERE status = $3';
      const countWhere = asset ? 'WHERE asset = $1 AND status = $2' : 'WHERE status = $1';
      const params = asset ? [limit, offset, asset, 'open'] : [limit, offset, 'open'];
      const countParams = asset ? [asset, 'open'] : ['open'];
      const count = await pool.query('SELECT COUNT(*)::int AS total FROM wathiq_offers ' + countWhere, countParams);
      const result = await pool.query('SELECT id,owner_id,title,asset,price,payment_method,status,created_at FROM wathiq_offers ' + where + ' ORDER BY created_at DESC LIMIT $1 OFFSET $2', params);
      return { items: result.rows.map(row => ({ id: Number(row.id), ownerId: row.owner_id == null ? null : Number(row.owner_id), title: row.title, asset: row.asset, price: Number(row.price), paymentMethod: row.payment_method, status: row.status, createdAt: new Date(row.created_at).toISOString() })), total: count.rows[0].total };
    }
    const filtered = asset ? offers.filter(item => item.asset === asset && item.status === 'open') : offers.filter(item => item.status === 'open');
    return { items: filtered.slice(offset, offset + limit), total: filtered.length };
  }
  function authenticate(req, res, next) {
    const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
    const payload = match && verifyToken(match[1], tokenSecret, Math.floor(now() / 1000));
    if (!payload) return res.status(401).json({ error: 'authentication required' });
    req.auth = { userId: payload.sub, role: payload.role };
    return next();
  }

  app.get('/health', async (_req, res) => {
    if (pool) {
      try { await pool.query('SELECT 1'); }
      catch { return res.status(503).json({ status: 'error', service: 'wathiq-api', database: 'unavailable' }); }
    }
    return res.json({ status: 'ok', service: 'wathiq-api', database: pool ? 'connected' : 'memory-test-mode' });
  });

  function authRateLimit(req, res, next) {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const current = now();
    const window = authWindow.get(key);
    if (window && current - window.startedAt < 15 * 60_000 && window.count >= 10) {
      return res.status(429).json({ error: 'too many authentication attempts; try again in 15 minutes' });
    }
    if (!window || current - window.startedAt >= 15 * 60_000) authWindow.set(key, { startedAt: current, count: 1 });
    else window.count += 1;
    return next();
  }

  app.post('/api/auth/register', authRateLimit, async (req, res, next) => {
    try {
      const body = req.body || {};
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: 'valid email required' });
      if (displayName.length < 2 || displayName.length > 80) return res.status(400).json({ error: 'displayName must be 2-80 characters' });
      if (password.length < 10 || password.length > 200) return res.status(400).json({ error: 'password must be 10-200 characters' });
      if (await findUserByEmail(email)) return res.status(409).json({ error: 'email already registered' });
      let user;
      try { user = await createUser({ email, displayName, password }); }
      catch (error) { if (error.code === '23505') return res.status(409).json({ error: 'email already registered' }); throw error; }
      const safeUser = userFromRow(user);
      const issuedAt = Math.floor(now() / 1000);
      const token = signToken({ sub: safeUser.id, role: safeUser.role, iat: issuedAt, exp: issuedAt + TOKEN_TTL_SECONDS }, tokenSecret);
      return res.status(201).json({ user: safeUser, token, tokenType: 'Bearer', expiresIn: TOKEN_TTL_SECONDS });
    } catch (error) { return next(error); }
  });

  app.post('/api/auth/login', authRateLimit, async (req, res, next) => {
    try {
      const body = req.body || {};
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const user = await findUserByEmail(email);
      if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) return res.status(401).json({ error: 'invalid email or password' });
      const safeUser = userFromRow(user);
      const issuedAt = Math.floor(now() / 1000);
      const token = signToken({ sub: safeUser.id, role: safeUser.role, iat: issuedAt, exp: issuedAt + TOKEN_TTL_SECONDS }, tokenSecret);
      return res.json({ user: safeUser, token, tokenType: 'Bearer', expiresIn: TOKEN_TTL_SECONDS });
    } catch (error) { return next(error); }
  });

  app.get('/api/auth/me', authenticate, async (req, res, next) => {
    try {
      const row = await findUserById(req.auth.userId);
      if (!row) return res.status(401).json({ error: 'account no longer exists' });
      return res.json({ user: userFromRow(row) });
    } catch (error) { return next(error); }
  });

  async function requireAdmin(req, res, next) {
    try {
      const row = await findUserById(req.auth.userId);
      if (!row) return res.status(401).json({ error: 'account no longer exists' });
      if (row.role !== 'admin') return res.status(403).json({ error: 'administrator access required' });
      req.admin = { id: Number(row.id), email: row.email };
      return next();
    } catch (error) { return next(error); }
  }

  app.get('/api/admin/overview', authenticate, requireAdmin, async (_req, res, next) => {
    try {
      if (pool) {
        const [usersCount, offersCount, openCount, closedCount] = await Promise.all([
          pool.query('SELECT COUNT(*)::int AS count FROM wathiq_users'),
          pool.query('SELECT COUNT(*)::int AS count FROM wathiq_offers'),
          pool.query("SELECT COUNT(*)::int AS count FROM wathiq_offers WHERE status = 'open'"),
          pool.query("SELECT COUNT(*)::int AS count FROM wathiq_offers WHERE status = 'closed'")
        ]);
        return res.json({ users: usersCount.rows[0].count, offers: offersCount.rows[0].count, openOffers: openCount.rows[0].count, closedOffers: closedCount.rows[0].count });
      }
      return res.json({
        users: users.length,
        offers: offers.length,
        openOffers: offers.filter(item => item.status === 'open').length,
        closedOffers: offers.filter(item => item.status === 'closed').length
      });
    } catch (error) { return next(error); }
  });

  app.get('/api/admin/users', authenticate, requireAdmin, async (req, res, next) => {
    try {
      const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
      const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
      if (pool) {
        const [count, result] = await Promise.all([
          pool.query('SELECT COUNT(*)::int AS total FROM wathiq_users'),
          pool.query('SELECT id,email,display_name,role,created_at FROM wathiq_users ORDER BY created_at DESC LIMIT $1 OFFSET $2', [limit, offset])
        ]);
        return res.json({ items: result.rows.map(userFromRow), total: count.rows[0].total, limit, offset });
      }
      const sorted = [...users].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      return res.json({ items: sorted.slice(offset, offset + limit).map(userFromRow), total: users.length, limit, offset });
    } catch (error) { return next(error); }
  });

  app.get('/api/admin/offers', authenticate, requireAdmin, async (req, res, next) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : 'all';
      if (!['all', 'open', 'closed'].includes(status)) return res.status(400).json({ error: 'status must be all, open, or closed' });
      const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
      const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
      if (pool) {
        const where = status === 'all' ? '' : ' WHERE status = $1';
        const countParams = status === 'all' ? [] : [status];
        const count = await pool.query('SELECT COUNT(*)::int AS total FROM wathiq_offers' + where, countParams);
        const params = status === 'all' ? [limit, offset] : [status, limit, offset];
        const limitPlaceholder = status === 'all' ? '$1' : '$2';
        const offsetPlaceholder = status === 'all' ? '$2' : '$3';
        const result = await pool.query(
          'SELECT id,owner_id,title,asset,price,payment_method,status,created_at FROM wathiq_offers' + where +
          ' ORDER BY created_at DESC LIMIT ' + limitPlaceholder + ' OFFSET ' + offsetPlaceholder,
          params
        );
        return res.json({
          items: result.rows.map(row => ({
            id: Number(row.id), ownerId: row.owner_id == null ? null : Number(row.owner_id),
            title: row.title, asset: row.asset, price: Number(row.price),
            paymentMethod: row.payment_method, status: row.status,
            createdAt: new Date(row.created_at).toISOString()
          })),
          total: count.rows[0].total, limit, offset
        });
      }
      const filtered = status === 'all' ? offers : offers.filter(item => item.status === status);
      const sorted = [...filtered].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return res.json({ items: sorted.slice(offset, offset + limit), total: filtered.length, limit, offset });
    } catch (error) { return next(error); }
  });

  app.patch('/api/admin/offers/:id/close', authenticate, requireAdmin, async (req, res, next) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'invalid offer id' });
      if (pool) {
        const result = await pool.query("UPDATE wathiq_offers SET status = 'closed' WHERE id = $1 AND status = 'open' RETURNING id", [id]);
        if (!result.rowCount) return res.status(404).json({ error: 'open offer not found' });
      } else {
        const offer = offers.find(item => item.id === id);
        if (!offer || offer.status !== 'open') return res.status(404).json({ error: 'open offer not found' });
        offer.status = 'closed';
      }
      return res.json({ status: 'closed', id, closedBy: req.admin.email });
    } catch (error) { return next(error); }
  });

  app.get('/api/offers', async (req, res, next) => {
    try {
      const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
      const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
      const asset = typeof req.query.asset === 'string' ? req.query.asset.toUpperCase() : null;
      if (asset && !ALLOWED_ASSETS.has(asset)) return res.status(400).json({ error: 'unsupported asset' });
      const result = await listOffers({ limit, offset, asset });
      return res.json({ items: result.items, total: result.total, limit, offset });
    } catch (error) { return next(error); }
  });

  app.get('/api/offers/:id', async (req, res, next) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'invalid offer id' });
      if (pool) {
        const result = await pool.query("SELECT id,owner_id,title,asset,price,payment_method,status,created_at FROM wathiq_offers WHERE id = $1 AND status = 'open'", [id]);
        if (!result.rows[0]) return res.status(404).json({ error: 'offer not found' });
        const row = result.rows[0];
        return res.json({ item: { id: Number(row.id), ownerId: row.owner_id == null ? null : Number(row.owner_id), title: row.title, asset: row.asset, price: Number(row.price), paymentMethod: row.payment_method, status: row.status, createdAt: new Date(row.created_at).toISOString() } });
      }
      const offer = offers.find(item => item.id === id && item.status === 'open');
      if (!offer) return res.status(404).json({ error: 'offer not found' });
      return res.json({ item: offer });
    } catch (error) { return next(error); }
  });

  app.post('/api/offers', authenticate, async (req, res, next) => {
    try {
      const body = req.body || {};
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      const asset = typeof body.asset === 'string' ? body.asset.toUpperCase() : '';
      const paymentMethod = typeof body.paymentMethod === 'string' ? body.paymentMethod : '';
      const price = body.price;
      if (title.length < 3 || title.length > 100) return res.status(400).json({ error: 'title must be 3-100 characters' });
      if (!ALLOWED_ASSETS.has(asset)) return res.status(400).json({ error: 'unsupported asset; MVP supports BNB only' });
      if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0 || price > 1_000_000_000) return res.status(400).json({ error: 'price must be a positive finite number within supported limits' });
      if (!ALLOWED_PAYMENT_METHODS.has(paymentMethod)) return res.status(400).json({ error: 'unsupported paymentMethod' });
      const clientKey = req.ip || req.socket.remoteAddress || 'unknown';
      const current = now();
      const previous = createWindow.get(clientKey);
      if (previous && current - previous.startedAt < 60_000 && previous.count >= maxCreatesPerMinute) return res.status(429).json({ error: 'rate limit exceeded; try again later' });
      if (!previous || current - previous.startedAt >= 60_000) createWindow.set(clientKey, { startedAt: current, count: 1 });
      else previous.count += 1;
      let offer;
      if (pool) {
        const result = await pool.query("INSERT INTO wathiq_offers (owner_id,title,asset,price,payment_method,status) VALUES ($1,$2,$3,$4,$5,'open') RETURNING id,owner_id,title,asset,price,payment_method,status,created_at", [req.auth.userId, title, asset, price, paymentMethod]);
        const row = result.rows[0];
        offer = { id: Number(row.id), ownerId: Number(row.owner_id), title: row.title, asset: row.asset, price: Number(row.price), paymentMethod: row.payment_method, status: row.status, createdAt: new Date(row.created_at).toISOString() };
      } else {
        offer = { id: offers.reduce((max, item) => Math.max(max, item.id), 0) + 1, ownerId: req.auth.userId, title, asset, price, paymentMethod, createdAt: new Date(current).toISOString(), status: 'open' };
        offers.push(offer);
      }
      return res.status(201).json({ item: offer });
    } catch (error) { return next(error); }
  });

  app.patch('/api/offers/:id/close', authenticate, async (req, res, next) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'invalid offer id' });
      if (pool) {
        const result = await pool.query("UPDATE wathiq_offers SET status = 'closed' WHERE id = $1 AND owner_id = $2 AND status = 'open' RETURNING id", [id, req.auth.userId]);
        if (!result.rowCount) return res.status(404).json({ error: 'open offer not found for this account' });
      } else {
        const offer = offers.find(item => item.id === id);
        if (!offer || offer.ownerId !== req.auth.userId || offer.status !== 'open') return res.status(404).json({ error: 'open offer not found for this account' });
        offer.status = 'closed';
      }
      return res.json({ status: 'closed', id });
    } catch (error) { return next(error); }
  });

  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.too.large' || err.status === 413) {
      return res.status(413).json({ error: 'request body too large; maximum is 32kb' });
    }
    if (err.type === 'entity.parse.failed' || err instanceof SyntaxError || err.status === 400) {
      return res.status(400).json({ error: 'invalid request body' });
    }
    if (err.code === '23505') return res.status(409).json({ error: 'conflict' });
    if (err.status && err.status < 500) return res.status(err.status).json({ error: 'invalid request' });
    if (process.env.NODE_ENV !== 'test') console.error('Wathiq API error:', err);
    return res.status(500).json({ error: 'internal server error' });
  });
  return app;
}

module.exports = { createApp, ensureSchema, hashPassword, verifyPassword, signToken, verifyToken };

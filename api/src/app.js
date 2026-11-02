const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { verifyFundingTx, amountToTokenUnits, getOnChainDealState } = require('./chain');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);

const ALLOWED_ASSETS = new Set(['BNB']);
const DEAL_ASSETS = new Set(['BNB', 'USDT']);
const ALLOWED_PAYMENT_METHODS = new Set(['bank_transfer', 'cash', 'crypto', 'digital_service', 'gift_card']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7;

function b64url(value) { return Buffer.from(value).toString('base64url'); }

// Match PostgreSQL NUMERIC(30, 10) precision in both database and memory mode.
// Counting from the canonical number string also handles scientific notation.
function hasAtMostDecimalPlaces(value, places) {
  const text = String(value).toLowerCase();
  const [coefficient, exponentText] = text.split('e');
  const fractionLength = (coefficient.split('.')[1] || '').length;
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  return Math.max(0, fractionLength - exponent) <= places;
}

function parseQueryInteger(value, defaultValue, min, max) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

// Route identifiers must be complete positive integers; parseInt would accept values like "12abc".
function parsePositiveId(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
function signToken(payload, secret) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const unsigned = header + '.' + body;
  return unsigned + '.' + crypto.createHmac('sha256', secret).update(unsigned).digest('base64url');
}
function verifyToken(token, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  // Bearer tokens issued here are tiny; cap input before decoding or hashing attacker data.
  if (typeof token !== 'string' || token.length > 8192) return null;
  const parts = token.split('.');
  // Buffer's base64url decoder is permissive and can ignore invalid characters.
  // Require canonical URL-safe alphabet before decoding any JWT segment.
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
  const unsigned = parts[0] + '.' + parts[1];
  const expected = crypto.createHmac('sha256', secret).update(unsigned).digest();
  let actual;
  try { actual = Buffer.from(parts[2], 'base64url'); } catch { return null; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    // This API only issues HS256 tokens; reject any other declared algorithm.
    if (!header || header.alg !== 'HS256' || header.typ !== 'JWT') return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!Number.isSafeInteger(payload.sub) || payload.sub <= 0 ||
        !Number.isSafeInteger(payload.exp) || payload.exp <= nowSeconds) return null;
    return payload;
  } catch { return null; }
}
async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derivedKey = await scrypt(password, salt, 64);
  return { salt, hash: derivedKey.toString('hex') };
}
async function verifyPassword(password, salt, expectedHex) {
  let expected;
  try { expected = Buffer.from(expectedHex, 'hex'); } catch { return false; }
  if (expected.length !== 64) return false;
  const actual = await scrypt(password, salt, 64);
  return crypto.timingSafeEqual(actual, expected);
}

// Keep attacker-controlled client-IP keys from growing the in-process maps forever.
function pruneRateLimitMap(map, current, windowMs, maxEntries = 5000) {
  if (map.size < maxEntries) return;
  for (const [key, entry] of map) {
    if (current - entry.startedAt >= windowMs) map.delete(key);
  }
  while (map.size >= maxEntries) map.delete(map.keys().next().value);
}

async function ensureSchema(pool) {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS wathiq_users (' +
    'id BIGSERIAL PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, ' +
    'password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, wallet_address TEXT, ' +
    "role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());" +
    'CREATE TABLE IF NOT EXISTS wathiq_offers (' +
    'id BIGSERIAL PRIMARY KEY, owner_id BIGINT REFERENCES wathiq_users(id) ON DELETE SET NULL, ' +
    'title VARCHAR(100) NOT NULL CHECK (char_length(title) BETWEEN 3 AND 100), ' +
    "asset TEXT NOT NULL CHECK (asset = 'BNB'), price NUMERIC(30, 10) NOT NULL CHECK (price > 0), " +
    "payment_method TEXT NOT NULL CHECK (payment_method IN ('bank_transfer','cash','crypto','digital_service','gift_card')), " +
    "status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());" +
    'CREATE INDEX IF NOT EXISTS wathiq_offers_created_idx ON wathiq_offers (created_at DESC);' +
    'CREATE INDEX IF NOT EXISTS wathiq_offers_asset_status_idx ON wathiq_offers (asset, status);' +
    'CREATE INDEX IF NOT EXISTS wathiq_offers_owner_created_idx ON wathiq_offers (owner_id, created_at DESC);' +
    'CREATE INDEX IF NOT EXISTS wathiq_offers_status_created_idx ON wathiq_offers (status, created_at DESC)'
  );
  await pool.query(
    'CREATE TABLE IF NOT EXISTS wathiq_deals (' +
    'id BIGSERIAL PRIMARY KEY, offer_id BIGINT REFERENCES wathiq_offers(id) ON DELETE SET NULL, ' +
    'title VARCHAR(100) NOT NULL CHECK (char_length(title) BETWEEN 3 AND 100), ' +
    "asset TEXT NOT NULL CHECK (asset IN ('BNB','USDT')), amount NUMERIC(30, 10) NOT NULL CHECK (amount > 0), " +
    'buyer_id BIGINT NOT NULL REFERENCES wathiq_users(id), seller_id BIGINT NOT NULL REFERENCES wathiq_users(id), arbiter_id BIGINT NOT NULL REFERENCES wathiq_users(id), ' +
    "status TEXT NOT NULL DEFAULT 'awaiting_funding' CHECK (status IN ('awaiting_funding','funded','delivered','released','refunded','cancelled')), " +
    'dispute BOOLEAN NOT NULL DEFAULT FALSE, dispute_reason VARCHAR(300), ' +
    "buyer_vote TEXT CHECK (buyer_vote IN ('release','refund')), seller_vote TEXT CHECK (seller_vote IN ('release','refund')), arbiter_vote TEXT CHECK (arbiter_vote IN ('release','refund')), " +
    'funded_at TIMESTAMPTZ, delivered_at TIMESTAMPTZ, settled_at TIMESTAMPTZ, chain_deal_id BIGINT, funding_tx_hash TEXT, funding_verified BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), ' +
    'CHECK (buyer_id <> seller_id AND buyer_id <> arbiter_id AND seller_id <> arbiter_id));' +
    'CREATE INDEX IF NOT EXISTS wathiq_deals_buyer_idx ON wathiq_deals (buyer_id, created_at DESC);' +
    'CREATE INDEX IF NOT EXISTS wathiq_deals_seller_idx ON wathiq_deals (seller_id, created_at DESC);' +
    'CREATE INDEX IF NOT EXISTS wathiq_deals_arbiter_idx ON wathiq_deals (arbiter_id, created_at DESC);' +
    'CREATE INDEX IF NOT EXISTS wathiq_deals_status_created_idx ON wathiq_deals (status, created_at DESC);' +
    'ALTER TABLE wathiq_users ADD COLUMN IF NOT EXISTS wallet_address TEXT;' +
    'ALTER TABLE wathiq_deals ADD COLUMN IF NOT EXISTS chain_deal_id BIGINT;' +
    'ALTER TABLE wathiq_deals ADD COLUMN IF NOT EXISTS funding_tx_hash TEXT;' +
    'ALTER TABLE wathiq_deals ADD COLUMN IF NOT EXISTS funding_verified BOOLEAN NOT NULL DEFAULT FALSE'
  );
}

function createApp(options = {}) {
  const app = express();
  const offers = options.offers || [];
  const users = options.users || [];
  const deals = options.deals || [];
  const createWindow = new Map();
  const authWindow = new Map();
  const now = options.now || (() => Date.now());
  const maxCreatesPerMinute = options.maxCreatesPerMinute ?? 20;
  const pool = options.pool || null;
  const chainConfig = options.chain || { rpcUrl: process.env.CHAIN_RPC_URL || '', usdtEscrowAddress: (process.env.USDT_ESCROW_ADDRESS || '').toLowerCase() };
  const production = process.env.NODE_ENV === 'production';
  const tokenSecret = options.tokenSecret || process.env.JWT_SECRET || (production ? '' : 'development-only-secret-change-me');
  if (production && !pool) throw new Error('DATABASE_URL is required in production');
  if (production && tokenSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters in production');
  const corsOrigin = process.env.CORS_ORIGIN || (production ? '' : 'http://localhost:4173');
  if (production) {
    let parsedOrigin;
    try { parsedOrigin = new URL(corsOrigin); } catch {}
    if (!parsedOrigin || parsedOrigin.protocol !== 'https:' || parsedOrigin.origin !== corsOrigin) {
      throw new Error('CORS_ORIGIN must be a single HTTPS origin without a path in production');
    }
  }

  app.disable('x-powered-by');
  // Render terminates the public connection at one trusted proxy hop; use the client IP
  // supplied by that proxy so rate limits are not shared by every visitor.
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({ origin: corsOrigin, methods: ['GET', 'POST', 'PATCH', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
  app.use(express.json({ limit: '32kb', strict: true }));

  const userFromRow = row => ({ id: Number(row.id), email: row.email, displayName: row.display_name, role: row.role, walletAddress: row.wallet_address || null, createdAt: new Date(row.created_at).toISOString() });
  async function findUserByEmail(email) {
    if (pool) { const result = await pool.query('SELECT * FROM wathiq_users WHERE email = $1', [email]); return result.rows[0] || null; }
    return users.find(user => user.email === email) || null;
  }
  async function findUserById(id) {
    if (pool) { const result = await pool.query('SELECT id,email,display_name,role,wallet_address,created_at FROM wathiq_users WHERE id = $1', [id]); return result.rows[0] || null; }
    return users.find(user => user.id === id) || null;
  }
  async function createUser({ email, displayName, password }) {
    const credentials = await hashPassword(password);
    if (pool) {
      const result = await pool.query('INSERT INTO wathiq_users (email,display_name,password_salt,password_hash) VALUES ($1,$2,$3,$4) RETURNING id,email,display_name,role,wallet_address,created_at', [email, displayName, credentials.salt, credentials.hash]);
      return result.rows[0];
    }
    const user = { id: users.reduce((max, item) => Math.max(max, item.id), 0) + 1, email, display_name: displayName, wallet_address: null, role: 'user', password_salt: credentials.salt, password_hash: credentials.hash, created_at: new Date(now()).toISOString() };
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
      const retryAfterSeconds = Math.max(1, Math.ceil((window.startedAt + 15 * 60_000 - current) / 1000));
      res.set('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({ error: 'too many authentication attempts; try again in 15 minutes' });
    }
    if (!window || current - window.startedAt >= 15 * 60_000) {
      if (!window) pruneRateLimitMap(authWindow, current, 15 * 60_000);
      authWindow.set(key, { startedAt: current, count: 1 });
    } else window.count += 1;
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
      const password = typeof body.password === 'string' ? body.password : null;
      // Reject malformed or excessive credentials before scrypt; malformed JSON types must not become 500s.
      if (password === null || password.length > 200) return res.status(401).json({ error: 'invalid email or password' });
      const user = await findUserByEmail(email);
      if (!user) {
        // Perform the same expensive password-hash operation for unknown accounts
        // so response timing reveals less about whether an email is registered.
        await scrypt(password, 'wathiq-login-dummy-salt', 64);
        return res.status(401).json({ error: 'invalid email or password' });
      }
      if (!(await verifyPassword(password, user.password_salt, user.password_hash))) {
        return res.status(401).json({ error: 'invalid email or password' });
      }
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

  app.patch('/api/auth/me', authenticate, async (req, res, next) => {
    try {
      const row = await findUserById(req.auth.userId);
      if (!row) return res.status(401).json({ error: 'account no longer exists' });
      const body = req.body || {};
      let displayName = row.display_name;
      let walletAddress = row.wallet_address || null;
      if (body.displayName !== undefined) {
        if (typeof body.displayName !== 'string' || body.displayName.trim().length < 2 || body.displayName.trim().length > 80) return res.status(400).json({ error: 'displayName must be 2-80 characters' });
        displayName = body.displayName.trim();
      }
      if (body.walletAddress !== undefined) {
        if (body.walletAddress === null || body.walletAddress === '') walletAddress = null;
        else if (typeof body.walletAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(body.walletAddress.trim())) return res.status(400).json({ error: 'walletAddress must be a 0x-prefixed 20-byte address' });
        else walletAddress = body.walletAddress.trim().toLowerCase();
      }
      if (pool) {
        const result = await pool.query('UPDATE wathiq_users SET display_name = $1, wallet_address = $2 WHERE id = $3 RETURNING id,email,display_name,role,wallet_address,created_at', [displayName, walletAddress, req.auth.userId]);
        return res.json({ user: userFromRow(result.rows[0]) });
      }
      const stored = users.find(user => user.id === req.auth.userId);
      if (stored) { stored.display_name = displayName; stored.wallet_address = walletAddress; }
      return res.json({ user: userFromRow({ ...row, display_name: displayName, wallet_address: walletAddress }) });
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
      const limit = parseQueryInteger(req.query.limit, 50, 1, 100);
      const offset = parseQueryInteger(req.query.offset, 0, 0, 1_000_000);
      if (limit === null || offset === null) return res.status(400).json({ error: 'limit must be 1-100 and offset must be 0-1000000 integers' });
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
      const limit = parseQueryInteger(req.query.limit, 50, 1, 100);
      const offset = parseQueryInteger(req.query.offset, 0, 0, 1_000_000);
      if (limit === null || offset === null) return res.status(400).json({ error: 'limit must be 1-100 and offset must be 0-1000000 integers' });
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
      const id = parsePositiveId(req.params.id);
      if (id === null) return res.status(400).json({ error: 'invalid offer id' });
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
      const limit = parseQueryInteger(req.query.limit, 20, 1, 50);
      const offset = parseQueryInteger(req.query.offset, 0, 0, 1_000_000);
      if (limit === null || offset === null) return res.status(400).json({ error: 'limit must be 1-50 and offset must be 0-1000000 integers' });
      const asset = typeof req.query.asset === 'string' ? req.query.asset.toUpperCase() : null;
      if (asset && !ALLOWED_ASSETS.has(asset)) return res.status(400).json({ error: 'unsupported asset' });
      const result = await listOffers({ limit, offset, asset });
      return res.json({ items: result.items, total: result.total, limit, offset });
    } catch (error) { return next(error); }
  });

  app.get('/api/offers/:id', async (req, res, next) => {
    try {
      const id = parsePositiveId(req.params.id);
      if (id === null) return res.status(400).json({ error: 'invalid offer id' });
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
      if (!hasAtMostDecimalPlaces(price, 10)) return res.status(400).json({ error: 'price supports at most 10 decimal places' });
      if (!ALLOWED_PAYMENT_METHODS.has(paymentMethod)) return res.status(400).json({ error: 'unsupported paymentMethod' });
      const clientKey = req.ip || req.socket.remoteAddress || 'unknown';
      const current = now();
      const previous = createWindow.get(clientKey);
      if (previous && current - previous.startedAt < 60_000 && previous.count >= maxCreatesPerMinute) {
        const retryAfterSeconds = Math.max(1, Math.ceil((previous.startedAt + 60_000 - current) / 1000));
        res.set('Retry-After', String(retryAfterSeconds));
        return res.status(429).json({ error: 'rate limit exceeded; try again later' });
      }
      if (!previous || current - previous.startedAt >= 60_000) {
        if (!previous) pruneRateLimitMap(createWindow, current, 60_000);
        createWindow.set(clientKey, { startedAt: current, count: 1 });
      } else previous.count += 1;
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


  // A signed-in account can inspect its own offers, including closed ones.
  app.get('/api/my/offers', authenticate, async (req, res, next) => {
    try {
      const limit = parseQueryInteger(req.query.limit, 20, 1, 50);
      const offset = parseQueryInteger(req.query.offset, 0, 0, 1_000_000);
      if (limit === null || offset === null) return res.status(400).json({ error: 'limit must be 1-50 and offset must be 0-1000000 integers' });
      if (pool) {
        const [count, result] = await Promise.all([
          pool.query('SELECT COUNT(*)::int AS total FROM wathiq_offers WHERE owner_id = $1', [req.auth.userId]),
          pool.query(
            'SELECT id,owner_id,title,asset,price,payment_method,status,created_at FROM wathiq_offers WHERE owner_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
            [req.auth.userId, limit, offset]
          )
        ]);
        const items = result.rows.map(row => ({
          id: Number(row.id), ownerId: row.owner_id == null ? null : Number(row.owner_id),
          title: row.title, asset: row.asset, price: Number(row.price),
          paymentMethod: row.payment_method, status: row.status,
          createdAt: new Date(row.created_at).toISOString()
        }));
        return res.json({ items, total: count.rows[0].total, limit, offset });
      }
      const owned = offers
        .filter(item => item.ownerId === req.auth.userId)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return res.json({ items: owned.slice(offset, offset + limit), total: owned.length, limit, offset });
    } catch (error) { return next(error); }
  });

  app.patch('/api/offers/:id/close', authenticate, async (req, res, next) => {
    try {
      const id = parsePositiveId(req.params.id);
      if (id === null) return res.status(400).json({ error: 'invalid offer id' });
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


  // ---- Escrow deals -------------------------------------------------------
  // Off-chain deal lifecycle that mirrors the on-chain escrow rules: three
  // distinct participants (buyer, seller, arbiter), funds marked as held,
  // delivery confirmation, then settlement by any 2-of-3 matching votes.
  // A deal that stays unresolved for 30 days after funding can be refunded
  // to the buyer by any participant, mirroring the USDT escrow timeout.
  const DEAL_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;
  const dealCreateWindow = new Map();

  function dealRoleOf(deal, userId) {
    if (Number(deal.buyer_id) === userId) return 'buyer';
    if (Number(deal.seller_id) === userId) return 'seller';
    if (Number(deal.arbiter_id) === userId) return 'arbiter';
    return null;
  }

  function dealToApi(row, viewerId) {
    const api = {
      id: Number(row.id),
      offerId: row.offer_id == null ? null : Number(row.offer_id),
      title: row.title,
      asset: row.asset,
      amount: Number(row.amount),
      status: row.status,
      dispute: row.dispute === true,
      disputeReason: row.dispute_reason || null,
      participants: {
        buyer: { id: Number(row.buyer_id), email: row.buyer_email || '', displayName: row.buyer_name || '' },
        seller: { id: Number(row.seller_id), email: row.seller_email || '', displayName: row.seller_name || '' },
        arbiter: { id: Number(row.arbiter_id), email: row.arbiter_email || '', displayName: row.arbiter_name || '' },
      },
      votes: { buyer: row.buyer_vote || null, seller: row.seller_vote || null, arbiter: row.arbiter_vote || null },
      chainDealId: row.chain_deal_id == null ? null : Number(row.chain_deal_id),
      fundingTxHash: row.funding_tx_hash || null,
      fundingVerified: row.funding_verified === true,
      fundedAt: row.funded_at ? new Date(row.funded_at).toISOString() : null,
      deliveredAt: row.delivered_at ? new Date(row.delivered_at).toISOString() : null,
      settledAt: row.settled_at ? new Date(row.settled_at).toISOString() : null,
      createdAt: new Date(row.created_at).toISOString(),
    };
    api.timeoutRefundAt = api.fundedAt ? new Date(new Date(api.fundedAt).getTime() + DEAL_TIMEOUT_MS).toISOString() : null;
    if (viewerId != null) api.myRole = dealRoleOf(row, viewerId);
    return api;
  }

  function enrichDealRow(deal) {
    const byId = id => users.find(user => Number(user.id) === Number(id)) || {};
    const buyer = byId(deal.buyer_id);
    const seller = byId(deal.seller_id);
    const arbiter = byId(deal.arbiter_id);
    return {
      ...deal,
      buyer_email: buyer.email || '', buyer_name: buyer.display_name || buyer.displayName || '',
      seller_email: seller.email || '', seller_name: seller.display_name || seller.displayName || '',
      arbiter_email: arbiter.email || '', arbiter_name: arbiter.display_name || arbiter.displayName || '',
    };
  }

  const DEAL_SELECT =
    'SELECT d.*, bu.email AS buyer_email, bu.display_name AS buyer_name, ' +
    'su.email AS seller_email, su.display_name AS seller_name, ' +
    'au.email AS arbiter_email, au.display_name AS arbiter_name ' +
    'FROM wathiq_deals d ' +
    'JOIN wathiq_users bu ON bu.id = d.buyer_id ' +
    'JOIN wathiq_users su ON su.id = d.seller_id ' +
    'JOIN wathiq_users au ON au.id = d.arbiter_id ';

  async function findDealById(id) {
    if (pool) {
      const result = await pool.query(DEAL_SELECT + 'WHERE d.id = $1', [id]);
      return result.rows[0] || null;
    }
    const deal = deals.find(item => item.id === id);
    return deal ? enrichDealRow(deal) : null;
  }

  async function saveDeal(deal) {
    if (pool) {
      await pool.query(
        'UPDATE wathiq_deals SET status = $1, dispute = $2, dispute_reason = $3, buyer_vote = $4, seller_vote = $5, arbiter_vote = $6, funded_at = $7, delivered_at = $8, settled_at = $9, chain_deal_id = $10, funding_tx_hash = $11, funding_verified = $12 WHERE id = $13',
        [deal.status, deal.dispute === true, deal.dispute_reason || null, deal.buyer_vote || null, deal.seller_vote || null, deal.arbiter_vote || null, deal.funded_at || null, deal.delivered_at || null, deal.settled_at || null, deal.chain_deal_id || null, deal.funding_tx_hash || null, deal.funding_verified === true, deal.id]
      );
      return findDealById(Number(deal.id));
    }
    const stored = deals.find(item => item.id === Number(deal.id));
    if (stored) {
      stored.status = deal.status;
      stored.dispute = deal.dispute === true;
      stored.dispute_reason = deal.dispute_reason || null;
      stored.buyer_vote = deal.buyer_vote || null;
      stored.seller_vote = deal.seller_vote || null;
      stored.arbiter_vote = deal.arbiter_vote || null;
      stored.funded_at = deal.funded_at || null;
      stored.delivered_at = deal.delivered_at || null;
      stored.settled_at = deal.settled_at || null;
      stored.chain_deal_id = deal.chain_deal_id || null;
      stored.funding_tx_hash = deal.funding_tx_hash || null;
      stored.funding_verified = deal.funding_verified === true;
      return enrichDealRow(stored);
    }
    return deal;
  }

  function evaluateDealSettlement(deal) {
    const votes = [deal.buyer_vote, deal.seller_vote, deal.arbiter_vote].filter(Boolean);
    const release = votes.filter(vote => vote === 'release').length;
    const refund = votes.filter(vote => vote === 'refund').length;
    if (release >= 2) { deal.status = 'released'; deal.settled_at = new Date(now()).toISOString(); return true; }
    if (refund >= 2) { deal.status = 'refunded'; deal.settled_at = new Date(now()).toISOString(); return true; }
    return false;
  }

  async function loadDealForParticipant(req, res) {
    const id = parsePositiveId(req.params.id);
    if (id === null) { res.status(400).json({ error: 'invalid deal id' }); return null; }
    const deal = await findDealById(id);
    // Non-participants get the same 404 as a missing deal so deal existence is not leaked.
    if (!deal || !dealRoleOf(deal, req.auth.userId)) { res.status(404).json({ error: 'deal not found' }); return null; }
    return deal;
  }

  app.post('/api/deals', authenticate, async (req, res, next) => {
    try {
      const body = req.body || {};
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      const asset = typeof body.asset === 'string' ? body.asset.toUpperCase() : '';
      const amount = body.amount;
      const myRole = body.myRole === undefined ? 'buyer' : body.myRole;
      const counterpartyEmail = typeof body.counterpartyEmail === 'string' ? body.counterpartyEmail.trim().toLowerCase() : '';
      const arbiterEmail = typeof body.arbiterEmail === 'string' ? body.arbiterEmail.trim().toLowerCase() : '';
      if (title.length < 3 || title.length > 100) return res.status(400).json({ error: 'title must be 3-100 characters' });
      if (!DEAL_ASSETS.has(asset)) return res.status(400).json({ error: 'unsupported asset; deals support BNB and USDT' });
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) return res.status(400).json({ error: 'amount must be a positive finite number within supported limits' });
      if (!hasAtMostDecimalPlaces(amount, 10)) return res.status(400).json({ error: 'amount supports at most 10 decimal places' });
      if (myRole !== 'buyer' && myRole !== 'seller') return res.status(400).json({ error: "myRole must be 'buyer' or 'seller'" });
      if (!EMAIL_RE.test(counterpartyEmail) || counterpartyEmail.length > 254) return res.status(400).json({ error: 'valid counterpartyEmail required' });
      if (!EMAIL_RE.test(arbiterEmail) || arbiterEmail.length > 254) return res.status(400).json({ error: 'valid arbiterEmail required' });
      const me = await findUserById(req.auth.userId);
      if (!me) return res.status(401).json({ error: 'account no longer exists' });
      const counterparty = await findUserByEmail(counterpartyEmail);
      if (!counterparty) return res.status(400).json({ error: 'counterparty account not found' });
      const arbiter = await findUserByEmail(arbiterEmail);
      if (!arbiter) return res.status(400).json({ error: 'arbiter account not found' });
      const myId = Number(me.id);
      const counterpartyId = Number(counterparty.id);
      const arbiterId = Number(arbiter.id);
      if (counterpartyId === myId) return res.status(400).json({ error: 'counterparty must be a different account' });
      if (arbiterId === myId || arbiterId === counterpartyId) return res.status(400).json({ error: 'arbiter must be a third, different account' });
      const buyerId = myRole === 'buyer' ? myId : counterpartyId;
      const sellerId = myRole === 'buyer' ? counterpartyId : myId;
      let offerId = null;
      if (body.offerId !== undefined && body.offerId !== null) {
        if (!Number.isSafeInteger(body.offerId) || body.offerId <= 0) return res.status(400).json({ error: 'invalid offerId' });
        offerId = body.offerId;
        let offerRow = null;
        if (pool) {
          const result = await pool.query('SELECT id,owner_id,status FROM wathiq_offers WHERE id = $1', [offerId]);
          offerRow = result.rows[0] || null;
          if (offerRow) offerRow = { ownerId: Number(offerRow.owner_id), status: offerRow.status };
        } else {
          const found = offers.find(item => item.id === offerId);
          if (found) offerRow = { ownerId: found.ownerId, status: found.status };
        }
        if (!offerRow) return res.status(404).json({ error: 'offer not found' });
        if (offerRow.status !== 'open') return res.status(400).json({ error: 'offer is not open' });
        if (offerRow.ownerId !== buyerId && offerRow.ownerId !== sellerId) return res.status(400).json({ error: 'offer is not owned by a deal participant' });
      }
      const clientKey = req.ip || req.socket.remoteAddress || 'unknown';
      const current = now();
      const previous = dealCreateWindow.get(clientKey);
      if (previous && current - previous.startedAt < 60_000 && previous.count >= maxCreatesPerMinute) {
        const retryAfterSeconds = Math.max(1, Math.ceil((previous.startedAt + 60_000 - current) / 1000));
        res.set('Retry-After', String(retryAfterSeconds));
        return res.status(429).json({ error: 'rate limit exceeded; try again later' });
      }
      if (!previous || current - previous.startedAt >= 60_000) {
        if (!previous) pruneRateLimitMap(dealCreateWindow, current, 60_000);
        dealCreateWindow.set(clientKey, { startedAt: current, count: 1 });
      } else previous.count += 1;
      let deal;
      if (pool) {
        const result = await pool.query(
          "INSERT INTO wathiq_deals (offer_id,title,asset,amount,buyer_id,seller_id,arbiter_id,status) VALUES ($1,$2,$3,$4,$5,$6,$7,'awaiting_funding') RETURNING id",
          [offerId, title, asset, amount, buyerId, sellerId, arbiterId]
        );
        deal = await findDealById(Number(result.rows[0].id));
      } else {
        const row = {
          id: deals.reduce((max, item) => Math.max(max, item.id), 0) + 1,
          offer_id: offerId, title, asset, amount,
          buyer_id: buyerId, seller_id: sellerId, arbiter_id: arbiterId,
          status: 'awaiting_funding', dispute: false, dispute_reason: null,
          buyer_vote: null, seller_vote: null, arbiter_vote: null,
          funded_at: null, delivered_at: null, settled_at: null,
          chain_deal_id: null, funding_tx_hash: null, funding_verified: false,
          created_at: new Date(current).toISOString(),
        };
        deals.push(row);
        deal = enrichDealRow(row);
      }
      return res.status(201).json({ item: dealToApi(deal, req.auth.userId) });
    } catch (error) { return next(error); }
  });

  app.get('/api/my/deals', authenticate, async (req, res, next) => {
    try {
      const limit = parseQueryInteger(req.query.limit, 20, 1, 50);
      const offset = parseQueryInteger(req.query.offset, 0, 0, 1_000_000);
      if (limit === null || offset === null) return res.status(400).json({ error: 'limit must be 1-50 and offset must be 0-1000000 integers' });
      if (pool) {
        const [count, result] = await Promise.all([
          pool.query('SELECT COUNT(*)::int AS total FROM wathiq_deals WHERE buyer_id = $1 OR seller_id = $1 OR arbiter_id = $1', [req.auth.userId]),
          pool.query(DEAL_SELECT + 'WHERE d.buyer_id = $1 OR d.seller_id = $1 OR d.arbiter_id = $1 ORDER BY d.created_at DESC LIMIT $2 OFFSET $3', [req.auth.userId, limit, offset]),
        ]);
        return res.json({ items: result.rows.map(row => dealToApi(row, req.auth.userId)), total: count.rows[0].total, limit, offset });
      }
      const mine = deals
        .filter(item => dealRoleOf(item, req.auth.userId))
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      return res.json({ items: mine.slice(offset, offset + limit).map(item => dealToApi(enrichDealRow(item), req.auth.userId)), total: mine.length, limit, offset });
    } catch (error) { return next(error); }
  });

  app.get('/api/deals/:id', authenticate, async (req, res, next) => {
    try {
      const deal = await loadDealForParticipant(req, res);
      if (!deal) return;
      return res.json({ item: dealToApi(deal, req.auth.userId) });
    } catch (error) { return next(error); }
  });

  app.post('/api/deals/:id/fund', authenticate, async (req, res, next) => {
    try {
      const deal = await loadDealForParticipant(req, res);
      if (!deal) return;
      if (dealRoleOf(deal, req.auth.userId) !== 'buyer') return res.status(403).json({ error: 'only the buyer can mark a deal as funded' });
      if (deal.status !== 'awaiting_funding') return res.status(409).json({ error: 'deal is not awaiting funding' });
      deal.status = 'funded';
      deal.funded_at = new Date(now()).toISOString();
      const saved = await saveDeal(deal);
      return res.json({ item: dealToApi(saved, req.auth.userId) });
    } catch (error) { return next(error); }
  });

  app.post('/api/deals/:id/link-chain', authenticate, async (req, res, next) => {
    try {
      const deal = await loadDealForParticipant(req, res);
      if (!deal) return;
      if (dealRoleOf(deal, req.auth.userId) !== 'buyer') return res.status(403).json({ error: 'only the buyer can link on-chain funding' });
      if (deal.status !== 'awaiting_funding') return res.status(409).json({ error: 'deal is not awaiting funding' });
      if (deal.asset !== 'USDT') return res.status(400).json({ error: 'on-chain funding verification is available for USDT deals' });
      if (!chainConfig.rpcUrl || !chainConfig.usdtEscrowAddress) return res.status(503).json({ error: 'on-chain funding verification is not configured on this server' });
      const txHash = typeof (req.body || {}).txHash === 'string' ? req.body.txHash.trim().toLowerCase() : '';
      if (!/^0x[0-9a-f]{64}$/.test(txHash)) return res.status(400).json({ error: 'txHash must be a 0x-prefixed 32-byte transaction hash' });
      const buyer = await findUserById(Number(deal.buyer_id));
      const seller = await findUserById(Number(deal.seller_id));
      const arbiter = await findUserById(Number(deal.arbiter_id));
      if (!buyer || !buyer.wallet_address || !seller || !seller.wallet_address || !arbiter || !arbiter.wallet_address) {
        return res.status(400).json({ error: 'buyer, seller and arbiter must all set a wallet address before on-chain funding' });
      }
      // One funding transaction (and one on-chain deal) funds exactly one platform deal.
      let clash = null;
      if (pool) {
        const result = await pool.query('SELECT id FROM wathiq_deals WHERE (funding_tx_hash = $1) AND id <> $2', [txHash, deal.id]);
        clash = result.rows[0] || null;
      } else {
        clash = deals.find(item => item.funding_tx_hash === txHash && Number(item.id) !== Number(deal.id)) || null;
      }
      if (clash) return res.status(409).json({ error: 'this transaction is already linked to another deal' });
      let verified;
      try {
        verified = await verifyFundingTx({
          rpcUrl: chainConfig.rpcUrl,
          escrowAddress: chainConfig.usdtEscrowAddress,
          txHash,
          expected: {
            buyer: buyer.wallet_address,
            seller: seller.wallet_address,
            arbiter: arbiter.wallet_address,
            amountUnits: amountToTokenUnits(Number(deal.amount)),
          },
        });
      } catch (error) {
        if (error && error.code) return res.status(400).json({ error: error.message });
        throw error;
      }
      if (pool) {
        const dupe = await pool.query('SELECT id FROM wathiq_deals WHERE chain_deal_id = $1 AND id <> $2', [verified.chainDealId, deal.id]);
        if (dupe.rows[0]) return res.status(409).json({ error: 'this on-chain deal is already linked to another deal' });
      } else if (deals.some(item => item.chain_deal_id === verified.chainDealId && Number(item.id) !== Number(deal.id))) {
        return res.status(409).json({ error: 'this on-chain deal is already linked to another deal' });
      }
      deal.status = 'funded';
      deal.funded_at = new Date(now()).toISOString();
      deal.chain_deal_id = verified.chainDealId;
      deal.funding_tx_hash = txHash;
      deal.funding_verified = true;
      const saved = await saveDeal(deal);
      return res.json({ item: dealToApi(saved, req.auth.userId) });
    } catch (error) { return next(error); }
  });

  app.post('/api/deals/:id/deliver', authenticate, async (req, res, next) => {
    try {
      const deal = await loadDealForParticipant(req, res);
      if (!deal) return;
      if (dealRoleOf(deal, req.auth.userId) !== 'seller') return res.status(403).json({ error: 'only the seller can mark a deal as delivered' });
      if (deal.status !== 'funded') return res.status(409).json({ error: 'deal is not in a deliverable state' });
      deal.status = 'delivered';
      deal.delivered_at = new Date(now()).toISOString();
      const saved = await saveDeal(deal);
      return res.json({ item: dealToApi(saved, req.auth.userId) });
    } catch (error) { return next(error); }
  });

  app.post('/api/deals/:id/cancel', authenticate, async (req, res, next) => {
    try {
      const deal = await loadDealForParticipant(req, res);
      if (!deal) return;
      const role = dealRoleOf(deal, req.auth.userId);
      if (role !== 'buyer' && role !== 'seller') return res.status(403).json({ error: 'only the buyer or seller can cancel a deal' });
      if (deal.status !== 'awaiting_funding') return res.status(409).json({ error: 'only an unfunded deal can be cancelled' });
      deal.status = 'cancelled';
      deal.settled_at = new Date(now()).toISOString();
      const saved = await saveDeal(deal);
      return res.json({ item: dealToApi(saved, req.auth.userId) });
    } catch (error) { return next(error); }
  });

  app.post('/api/deals/:id/dispute', authenticate, async (req, res, next) => {
    try {
      const deal = await loadDealForParticipant(req, res);
      if (!deal) return;
      if (deal.status !== 'funded' && deal.status !== 'delivered') return res.status(409).json({ error: 'only a funded deal can be disputed' });
      if (deal.dispute === true) return res.status(409).json({ error: 'a dispute is already open for this deal' });
      const reason = typeof (req.body || {}).reason === 'string' ? req.body.reason.trim() : '';
      if (reason.length > 300) return res.status(400).json({ error: 'reason must be at most 300 characters' });
      deal.dispute = true;
      deal.dispute_reason = reason || null;
      const saved = await saveDeal(deal);
      return res.json({ item: dealToApi(saved, req.auth.userId) });
    } catch (error) { return next(error); }
  });

  app.post('/api/deals/:id/vote', authenticate, async (req, res, next) => {
    try {
      const deal = await loadDealForParticipant(req, res);
      if (!deal) return;
      const decision = (req.body || {}).decision;
      if (decision !== 'release' && decision !== 'refund') return res.status(400).json({ error: "decision must be 'release' or 'refund'" });
      if (deal.status !== 'funded' && deal.status !== 'delivered') return res.status(409).json({ error: 'deal is not open for voting' });
      const role = dealRoleOf(deal, req.auth.userId);
      const field = role + '_vote';
      if (deal[field]) return res.status(409).json({ error: 'your vote has already been recorded' });
      deal[field] = decision;
      evaluateDealSettlement(deal);
      const saved = await saveDeal(deal);
      return res.json({ item: dealToApi(saved, req.auth.userId) });
    } catch (error) { return next(error); }
  });

  // For chain-verified deals the contract is authoritative: when it has
  // settled (released or refunded), mirror that outcome onto the record.
  async function syncDealFromChain(deal) {
    const chainState = await getOnChainDealState({
      rpcUrl: chainConfig.rpcUrl,
      escrowAddress: chainConfig.usdtEscrowAddress,
      chainDealId: deal.chain_deal_id,
    });
    if ((chainState.status === 'released' || chainState.status === 'refunded') && deal.status !== chainState.status) {
      deal.status = chainState.status;
      deal.settled_at = new Date(now()).toISOString();
      return { deal: await saveDeal(deal), chainState, updated: true };
    }
    return { deal, chainState, updated: false };
  }

  app.post('/api/deals/:id/sync-chain', authenticate, async (req, res, next) => {
    try {
      const deal = await loadDealForParticipant(req, res);
      if (!deal) return;
      if (!chainConfig.rpcUrl || !chainConfig.usdtEscrowAddress) return res.status(503).json({ error: 'on-chain sync is not configured on this server' });
      if (deal.funding_verified !== true || deal.chain_deal_id == null) return res.status(400).json({ error: 'deal is not linked to a verified on-chain deal' });
      let result;
      try {
        result = await syncDealFromChain(deal);
      } catch (error) {
        if (error && error.code) return res.status(400).json({ error: error.message });
        throw error;
      }
      return res.json({
        item: dealToApi(result.deal, req.auth.userId),
        chainStatus: result.chainState.status,
        chainReleaseVotes: result.chainState.releaseVotes,
        chainRefundVotes: result.chainState.refundVotes,
        updated: result.updated,
      });
    } catch (error) { return next(error); }
  });

  app.post('/api/deals/:id/timeout-refund', authenticate, async (req, res, next) => {
    try {
      const deal = await loadDealForParticipant(req, res);
      if (!deal) return;
      if (deal.status !== 'funded' && deal.status !== 'delivered') return res.status(409).json({ error: 'deal is not eligible for a timeout refund' });
      const fundedAtMs = deal.funded_at ? new Date(deal.funded_at).getTime() : 0;
      if (!fundedAtMs || now() - fundedAtMs < DEAL_TIMEOUT_MS) return res.status(400).json({ error: 'timeout refund is available 30 days after funding' });
      deal.status = 'refunded';
      deal.settled_at = new Date(now()).toISOString();
      const saved = await saveDeal(deal);
      return res.json({ item: dealToApi(saved, req.auth.userId) });
    } catch (error) { return next(error); }
  });

  app.post('/api/admin/deals/sync-chain', authenticate, requireAdmin, async (req, res, next) => {
    try {
      if (!chainConfig.rpcUrl || !chainConfig.usdtEscrowAddress) return res.status(503).json({ error: 'on-chain sync is not configured on this server' });
      let rows;
      if (pool) {
        const result = await pool.query(DEAL_SELECT + "WHERE d.funding_verified = TRUE AND d.status IN ('funded','delivered')");
        rows = result.rows;
      } else {
        rows = deals
          .filter(item => item.funding_verified === true && (item.status === 'funded' || item.status === 'delivered'))
          .map(item => enrichDealRow(item));
      }
      let updated = 0;
      let failed = 0;
      for (const row of rows) {
        try {
          const result = await syncDealFromChain(row);
          if (result.updated) updated += 1;
        } catch { failed += 1; }
      }
      return res.json({ checked: rows.length, updated, failed });
    } catch (error) { return next(error); }
  });

  app.get('/api/admin/deals', authenticate, requireAdmin, async (req, res, next) => {
    try {
      const limit = parseQueryInteger(req.query.limit, 20, 1, 50);
      const offset = parseQueryInteger(req.query.offset, 0, 0, 1_000_000);
      if (limit === null || offset === null) return res.status(400).json({ error: 'limit must be 1-50 and offset must be 0-1000000 integers' });
      const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : null;
      if (pool) {
        const count = await pool.query('SELECT COUNT(*)::int AS total FROM wathiq_deals' + (status ? ' WHERE status = $1' : ''), status ? [status] : []);
        const result = await pool.query(DEAL_SELECT + (status ? 'WHERE d.status = $3' : '') + ' ORDER BY d.created_at DESC LIMIT $1 OFFSET $2', status ? [limit, offset, status] : [limit, offset]);
        return res.json({ items: result.rows.map(row => dealToApi(row, null)), total: count.rows[0].total, limit, offset });
      }
      const filtered = deals
        .filter(item => !status || item.status === status)
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      return res.json({ items: filtered.slice(offset, offset + limit).map(item => dealToApi(enrichDealRow(item), null)), total: filtered.length, limit, offset });
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

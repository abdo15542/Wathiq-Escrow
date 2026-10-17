const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const ALLOWED_ASSETS = new Set(['BNB']);
const ALLOWED_PAYMENT_METHODS = new Set(['bank_transfer', 'cash', 'crypto', 'digital_service', 'gift_card']);

function createApp(options = {}) {
  const app = express();
  const offers = options.offers || [];
  const createWindow = new Map();
  const now = options.now || (() => Date.now());
  const maxCreatesPerMinute = options.maxCreatesPerMinute ?? 20;

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:4173' }));
  app.use(express.json({ limit: '32kb', strict: true }));

  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'wathiq-api', mode: process.env.NODE_ENV || 'development' }));

  app.get('/api/offers', (req, res) => {
    const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
    const asset = typeof req.query.asset === 'string' ? req.query.asset.toUpperCase() : null;
    const filtered = asset ? offers.filter(item => item.asset === asset) : offers;
    return res.json({ items: filtered.slice(offset, offset + limit), total: filtered.length, limit, offset });
  });

  app.get('/api/offers/:id', (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'invalid offer id' });
    const offer = offers.find(item => item.id === id);
    if (!offer) return res.status(404).json({ error: 'offer not found' });
    return res.json({ item: offer });
  });

  app.post('/api/offers', (req, res) => {
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

    const offer = {
      id: offers.reduce((max, item) => Math.max(max, item.id), 0) + 1,
      title, asset, price, paymentMethod,
      createdAt: new Date(current).toISOString(),
      status: 'draft',
    };
    offers.push(offer);
    return res.status(201).json({ item: offer });
  });

  app.use((err, _req, res, _next) => {
    if (err instanceof SyntaxError || err.status === 400) return res.status(400).json({ error: 'invalid request body' });
    return res.status(500).json({ error: 'internal server error' });
  });
  return app;
}

module.exports = { createApp };

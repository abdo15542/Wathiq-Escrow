const { Pool } = require('pg');
const { createApp, ensureSchema } = require('./app');
const { createPoolOptions } = require('./db-config');

async function start() {
  const production = process.env.NODE_ENV === 'production';
  if (production && !process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required; refusing to start with ephemeral in-memory data.');
  }
  if (production && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
    throw new Error('JWT_SECRET must be at least 32 characters in production.');
  }

  let pool = null;
  if (process.env.DATABASE_URL) {
    pool = new Pool(createPoolOptions());
    await pool.query('SELECT 1');
    await ensureSchema(pool);
  }

  const app = createApp({ pool });
  const port = Number(process.env.PORT || 4000);
  // Render's public web services must bind to the container's public interface.
  const server = app.listen(port, '0.0.0.0', () => {
    console.log('Wathiq API listening on ' + port + (pool ? ' with PostgreSQL' : ' in development memory mode'));
  });
  const shutdown = async () => {
    server.close(async () => {
      if (pool) await pool.end();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
start().catch(error => {
  console.error('Wathiq API failed to start:', error.message);
  process.exit(1);
});

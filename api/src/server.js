const { Pool } = require('pg');
const { createApp, ensureSchema } = require('./app');

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
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
      max: Number(process.env.PGPOOL_MAX || 10),
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
    });
    await pool.query('SELECT 1');
    await ensureSchema(pool);
  }

  const app = createApp({ pool });
  const port = Number(process.env.PORT || 4000);
  const server = app.listen(port, () => console.log('Wathiq API listening on ' + port + (pool ? ' with PostgreSQL' : ' in development memory mode')));
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

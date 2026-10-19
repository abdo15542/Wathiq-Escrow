function createPoolOptions(env = process.env) {
  const configuredMax = Number(env.PGPOOL_MAX);
  const max = Number.isInteger(configuredMax) && configuredMax >= 1 && configuredMax <= 100
    ? configuredMax
    : 10;

  return {
    connectionString: env.DATABASE_URL,
    // Verify the database certificate by default. Disabling TLS is an explicit
    // opt-out for local development only; production should keep verification on.
    ssl: env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: true },
    max,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
  };
}

module.exports = { createPoolOptions };

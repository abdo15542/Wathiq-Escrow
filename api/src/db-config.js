function createPoolOptions(env = process.env) {
  if (env.NODE_ENV === 'production' && env.PGSSLMODE === 'disable') {
    throw new Error('PostgreSQL TLS cannot be disabled in production.');
  }
  const configuredMax = Number(env.PGPOOL_MAX);
  const max = Number.isInteger(configuredMax) && configuredMax >= 1 && configuredMax <= 100
    ? configuredMax
    : 10;

  const ssl = env.PGSSLMODE === 'disable' ? false : {
    // Render and some managed PostgreSQL providers use a private CA. Supply its
    // PEM certificate explicitly rather than disabling certificate validation.
    rejectUnauthorized: true,
    ...(typeof env.PGSSL_CA_CERT === 'string' && env.PGSSL_CA_CERT.trim()
      ? { ca: env.PGSSL_CA_CERT }
      : {}),
  };

  return {
    connectionString: env.DATABASE_URL,
    // Verify the database certificate by default. Production must not disable TLS.
    ssl,
    max,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    // Bound slow queries and abandoned transactions so a stalled DB cannot
    // indefinitely occupy an API worker or a pool connection.
    statement_timeout: 10000,
    query_timeout: 12000,
    idle_in_transaction_session_timeout: 15000,
    application_name: 'wathiq-api',
  };
}

module.exports = { createPoolOptions };

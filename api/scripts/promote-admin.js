const { Pool } = require('pg');

async function main() {
  const email = String(process.argv[2] || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Usage: node api/scripts/promote-admin.js existing-user@example.com');
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required; refusing to change any account.');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
    max: 1,
  });
  try {
    const result = await pool.query(
      "UPDATE wathiq_users SET role = 'admin' WHERE email = $1 RETURNING id, email, role",
      [email],
    );
    if (result.rowCount !== 1) {
      throw new Error('No existing account matched that email. Register the account first, then retry.');
    }
    console.log('Administrator role granted to existing account:', result.rows[0].email);
    console.log('Sign out and sign back in to refresh the session.');
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error('Admin promotion failed:', error.message);
  process.exitCode = 1;
});

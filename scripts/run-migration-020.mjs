import mysql from 'mysql2/promise';

async function main() {
  const DATABASE_URL = process.env.DATABASE_URL || 'mysql://swarm:swarmpass@localhost:3306/swarm';
  const conn = await mysql.createConnection({ uri: DATABASE_URL });

  // Check current column type
  const [rows] = await conn.execute("SHOW COLUMNS FROM llm_providers LIKE 'api_key_ref'");
  console.log('Current column:', JSON.stringify(rows, null, 2));

  if (rows.length > 0 && rows[0].Type !== 'text') {
    console.log('Running migration: ALTER TABLE llm_providers MODIFY COLUMN api_key_ref TEXT NOT NULL');
    await conn.execute('ALTER TABLE llm_providers MODIFY COLUMN api_key_ref TEXT NOT NULL');
    console.log('Migration applied successfully.');
  } else {
    console.log('Column is already TEXT or not found — nothing to do.');
  }

  await conn.end();
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});

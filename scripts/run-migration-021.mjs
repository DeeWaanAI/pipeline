import mysql from 'mysql2/promise';

async function main() {
  const DATABASE_URL = process.env.DATABASE_URL || 'mysql://swarm:swarmpass@localhost:3306/swarm';
  const conn = await mysql.createConnection({ uri: DATABASE_URL });

  console.log('Running migration 021: widen content columns to MEDIUMTEXT + add swarm_runs.error');

  // 1. agent_runs
  const [arCtx] = await conn.execute("SHOW COLUMNS FROM agent_runs LIKE 'context_input'");
  if (arCtx.length > 0 && arCtx[0].Type !== 'mediumtext') {
    await conn.execute('ALTER TABLE agent_runs MODIFY COLUMN system_prompt MEDIUMTEXT, MODIFY COLUMN user_prompt MEDIUMTEXT NOT NULL, MODIFY COLUMN context_input MEDIUMTEXT');
    console.log('  agent_runs: system_prompt, user_prompt, context_input → MEDIUMTEXT');
  } else {
    console.log('  agent_runs columns already MEDIUMTEXT or not found — skipping');
  }

  // 2. agent_responses
  const [arRsp] = await conn.execute("SHOW COLUMNS FROM agent_responses LIKE 'content'");
  if (arRsp.length > 0 && arRsp[0].Type !== 'mediumtext') {
    await conn.execute('ALTER TABLE agent_responses MODIFY COLUMN content MEDIUMTEXT NOT NULL');
    console.log('  agent_responses: content → MEDIUMTEXT');
  } else {
    console.log('  agent_responses.content already MEDIUMTEXT or not found — skipping');
  }

  // 3. swarm_runs
  const [srUp] = await conn.execute("SHOW COLUMNS FROM swarm_runs LIKE 'user_prompt'");
  if (srUp.length > 0 && srUp[0].Type !== 'mediumtext') {
    await conn.execute('ALTER TABLE swarm_runs MODIFY COLUMN user_prompt MEDIUMTEXT NOT NULL');
    console.log('  swarm_runs: user_prompt → MEDIUMTEXT');
  } else {
    console.log('  swarm_runs.user_prompt already MEDIUMTEXT or not found — skipping');
  }

  // 4. Add error column
  const [srErr] = await conn.execute("SHOW COLUMNS FROM swarm_runs LIKE 'error'");
  if (srErr.length === 0) {
    await conn.execute('ALTER TABLE swarm_runs ADD COLUMN error TEXT AFTER batch_id');
    console.log('  swarm_runs: added error TEXT column');
  } else {
    console.log('  swarm_runs.error already exists — skipping');
  }

  // Verify
  console.log('\n--- Verification ---');
  const [vCtx] = await conn.execute("SHOW COLUMNS FROM agent_runs LIKE 'context_input'");
  console.log('agent_runs.context_input:', vCtx[0]?.Type ?? 'NOT FOUND');
  const [vErr] = await conn.execute("SHOW COLUMNS FROM swarm_runs LIKE 'error'");
  console.log('swarm_runs.error:', vErr[0]?.Type ?? 'NOT FOUND');

  await conn.end();
  console.log('\nMigration 021 complete.');
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});

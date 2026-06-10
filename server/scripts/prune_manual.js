(async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/thirdlayer' });
  try {
    console.log('Pruning comments via manual SQL');
    await pool.query("UPDATE rows SET data = data - 'comments' WHERE tenant_id='default' AND table_name='issues'");
    const r = await pool.query("SELECT key, data FROM rows WHERE tenant_id='default' AND table_name='issues' ORDER BY key");
    console.log(r.rows);
  } catch (e) {
    console.error('prune failed', e);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();

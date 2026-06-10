(async () => {
  const { Pool } = require('pg');
  const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/thirdlayer';
  const pool = new Pool({ connectionString });
  try {
    const ml = await pool.query('SELECT id, tenant_id, table_name, message, created_at FROM migration_logs ORDER BY id DESC LIMIT 20');
    console.log('migration_logs:', ml.rows);
    const idx = await pool.query("SELECT indexname, indexdef FROM pg_indexes WHERE tablename='rows'");
    console.log('pg_indexes:', idx.rows);
    const rows = await pool.query("SELECT tenant_id, table_name, key, data FROM rows WHERE table_name='issues' ORDER BY key");
    console.log('rows:', rows.rows);
    const commentsCount = await pool.query("SELECT count(*) as c FROM rows WHERE table_name='issues' AND (data ? 'comments')");
    console.log('rows_with_comments_count:', commentsCount.rows[0].c);
    const priorityCount = await pool.query("SELECT count(*) as c FROM rows WHERE table_name='issues' AND (data ? 'priority')");
    console.log('rows_with_priority_count:', priorityCount.rows[0].c);
  } catch (e) {
    console.error('db_check error', e);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();

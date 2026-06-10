(async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/thirdlayer' });
  try {
    console.log('Coercing isUrgent -> priority (boolean -> int)');
    await pool.query("UPDATE rows SET data = jsonb_set(data, '{priority}', to_jsonb((data->>'isUrgent')::boolean::int)) WHERE tenant_id='default' AND table_name='issues' AND data ? 'isUrgent'");
    console.log('Coercing string boolean priority -> int');
    await pool.query("UPDATE rows SET data = jsonb_set(data, '{priority}', to_jsonb((data->>'priority')::boolean::int)) WHERE tenant_id='default' AND table_name='issues' AND data ? 'priority' AND (data->>'priority') IN ('true','false')");
    console.log('done');
  } catch (e) {
    console.error('fix_priority failed', e);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();

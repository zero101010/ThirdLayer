(async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/thirdlayer' });
  try {
    console.log('Checking and migrating rows/table_schemas to include tenant_id...');
    await pool.query("ALTER TABLE rows ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'");
    // drop existing PK if exists
    await pool.query("DO $$\nBEGIN\n  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='rows_pkey') THEN\n    ALTER TABLE rows DROP CONSTRAINT rows_pkey;\n  END IF;\nEND$$;");
    await pool.query("ALTER TABLE rows ADD PRIMARY KEY (tenant_id, table_name, key)");

    await pool.query("ALTER TABLE table_schemas ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'");
    await pool.query("DO $$\nBEGIN\n  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='table_schemas_pkey') THEN\n    ALTER TABLE table_schemas DROP CONSTRAINT table_schemas_pkey;\n  END IF;\nEND$$;");
    await pool.query("ALTER TABLE table_schemas ADD PRIMARY KEY (tenant_id, table_name)");

    // Ensure migration_logs has tenant_id for auditing
    await pool.query("ALTER TABLE migration_logs ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'");

    console.log('Migration applied.');
  } catch (e) {
    console.error('upgrade_schema failed', e);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();

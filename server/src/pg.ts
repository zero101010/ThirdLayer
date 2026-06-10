import dotenv from 'dotenv';
import { Pool } from 'pg';
import crypto from 'crypto';

dotenv.config();

const connectionString = process.env.DATABASE_URL || 'postgresql://localhost:5432/thirdlayer';

export const pool = new Pool({ connectionString });

export async function initDb() {
  // create necessary tables
  await pool.query(`CREATE TABLE IF NOT EXISTS rows (
    tenant_id TEXT NOT NULL DEFAULT 'default',
    table_name TEXT NOT NULL,
    key TEXT NOT NULL,
    data JSONB,
    updated_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (tenant_id, table_name, key)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS table_schemas (
    tenant_id TEXT NOT NULL DEFAULT 'default',
    table_name TEXT NOT NULL,
    primary_key TEXT,
    schema JSONB,
    schema_version INT DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (tenant_id, table_name)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS migration_logs (
    id SERIAL PRIMARY KEY,
    tenant_id TEXT,
    table_name TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    message TEXT
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS tenants (
    tenant_id TEXT PRIMARY KEY,
    api_key_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS sync_states (
    tenant_id TEXT NOT NULL,
    sync_name TEXT NOT NULL,
    state JSONB,
    updated_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (tenant_id, sync_name)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS deployed_projects (
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    module_path TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (tenant_id, name)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS sync_run_requests (
    id BIGSERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    sync_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS datasource_configs (
    tenant_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    config_encrypted TEXT NOT NULL,
    config_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (tenant_id, provider)
  )`);
}

export async function createTenant(tenantId: string): Promise<{ tenantId: string; created: boolean; apiKey: string | null }> {
  const raw = crypto.randomBytes(24).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const res = await pool.query(
    `INSERT INTO tenants(tenant_id, api_key_hash, created_at)
     VALUES($1, $2, now())
     ON CONFLICT (tenant_id) DO NOTHING
     RETURNING tenant_id`,
    [tenantId, hash]
  );
  if (res.rowCount === 0) {
    return { tenantId, created: false, apiKey: null };
  }
  return { tenantId, created: true, apiKey: raw };
}

export async function verifyTenantKey(tenantId: string, apiKey: string) {
  if (!tenantId || !apiKey) return false;
  const hash = crypto.createHash('sha256').update(apiKey).digest('hex');
  const res = await pool.query('SELECT api_key_hash FROM tenants WHERE tenant_id=$1', [tenantId]);
  if (!res.rows[0]) return false;
  return res.rows[0].api_key_hash === hash;
}

export async function listTenants() {
  const res = await pool.query('SELECT tenant_id, created_at FROM tenants');
  return res.rows;
}

export async function getTableSchema(tenantId: string, tableName: string) {
  const res = await pool.query('SELECT schema FROM table_schemas WHERE tenant_id=$1 AND table_name=$2', [tenantId, tableName]);
  return res.rows[0]?.schema ?? undefined;
}

export async function upsertDatasourceConfig(tenantId: string, provider: string, config: Record<string, any>) {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  if (!normalizedProvider) throw new Error('provider required');
  const payload = JSON.stringify(config ?? {});
  const encrypted = encryptSecretPayload(payload);
  const hash = crypto.createHash('sha256').update(payload).digest('hex');

  await pool.query(
    `INSERT INTO datasource_configs(tenant_id, provider, config_encrypted, config_hash, created_at, updated_at)
     VALUES($1, $2, $3, $4, now(), now())
     ON CONFLICT (tenant_id, provider)
     DO UPDATE SET config_encrypted=EXCLUDED.config_encrypted, config_hash=EXCLUDED.config_hash, updated_at=now()`,
    [tenantId, normalizedProvider, encrypted, hash]
  );

  return { tenantId, provider: normalizedProvider, configHash: hash };
}

export async function getDatasourceConfig(tenantId: string, provider: string): Promise<Record<string, any> | undefined> {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  if (!normalizedProvider) return undefined;
  const res = await pool.query(
    'SELECT config_encrypted FROM datasource_configs WHERE tenant_id=$1 AND provider=$2',
    [tenantId, normalizedProvider]
  );
  if (!res.rows[0]?.config_encrypted) return undefined;
  const decrypted = decryptSecretPayload(String(res.rows[0].config_encrypted));
  const parsed = JSON.parse(decrypted);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, any>;
}

export async function getSyncState(tenantId: string, syncName: string) {
  const res = await pool.query('SELECT state FROM sync_states WHERE tenant_id=$1 AND sync_name=$2', [tenantId, syncName]);
  return res.rows[0]?.state ?? undefined;
}

export async function setSyncState(tenantId: string, syncName: string, state: any) {
  await pool.query(
    `INSERT INTO sync_states(tenant_id, sync_name, state, updated_at)
     VALUES($1, $2, $3, now())
     ON CONFLICT (tenant_id, sync_name)
     DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
    [tenantId, syncName, state ?? null]
  );
}

export async function upsertDeployedProject(tenantId: string, name: string, modulePath: string) {
  await pool.query(
    `INSERT INTO deployed_projects(tenant_id, name, module_path, enabled, created_at, updated_at)
     VALUES($1, $2, $3, true, now(), now())
     ON CONFLICT (tenant_id, name)
     DO UPDATE SET module_path = EXCLUDED.module_path, enabled = true, updated_at = now()`,
    [tenantId, name, modulePath]
  );
}

export async function listDeployedProjects(tenantId?: string) {
  if (tenantId) {
    const res = await pool.query(
      'SELECT tenant_id, name, module_path, enabled, created_at, updated_at FROM deployed_projects WHERE tenant_id=$1 AND enabled=true ORDER BY tenant_id, name',
      [tenantId]
    );
    return res.rows;
  }
  const res = await pool.query(
    'SELECT tenant_id, name, module_path, enabled, created_at, updated_at FROM deployed_projects WHERE enabled=true ORDER BY tenant_id, name'
  );
  return res.rows;
}

export async function enqueueSyncRunRequest(tenantId: string, syncName: string) {
  const res = await pool.query(
    `INSERT INTO sync_run_requests(tenant_id, sync_name, status, created_at, updated_at)
     VALUES($1, $2, 'pending', now(), now())
     RETURNING id, tenant_id, sync_name, status, created_at`,
    [tenantId, syncName]
  );
  return res.rows[0];
}

export async function listPendingSyncRunRequests(limit = 50) {
  const res = await pool.query(
    `SELECT id, tenant_id, sync_name
     FROM sync_run_requests
     WHERE status='pending'
     ORDER BY id ASC
     LIMIT $1`,
    [limit]
  );
  return res.rows;
}

export async function markSyncRunRequestStatus(id: number, status: 'running' | 'done' | 'failed', error?: string) {
  await pool.query(
    `UPDATE sync_run_requests
     SET status=$2, error=$3, updated_at=now()
     WHERE id=$1`,
    [id, status, error ?? null]
  );
}

export async function migrateTableSchema(tenantId: string, tableName: string, primaryKey: string, newSchema: any, options: { destructive?: boolean } = {}) {
  // Get existing schema for tenant
  const res = await pool.query('SELECT schema, schema_version FROM table_schemas WHERE tenant_id=$1 AND table_name=$2', [tenantId, tableName]);
  if (!res.rows[0]) {
    await pool.query(
      `INSERT INTO table_schemas(tenant_id, table_name, primary_key, schema, schema_version, created_at) VALUES($1, $2, $3, $4, 1, now())`,
      [tenantId, tableName, primaryKey, JSON.stringify(newSchema)]
    );
    return { applied: true, reason: 'created' };
  }

  const existing = res.rows[0].schema || {};
  const existingVersion = res.rows[0].schema_version || 1;

  const existingKeys = Object.keys(existing);
  const newKeys = Object.keys(newSchema);

  const added = newKeys.filter((k) => !existingKeys.includes(k));
  const removed = existingKeys.filter((k) => !newKeys.includes(k));
  const typeChanged = newKeys.filter((k) => existingKeys.includes(k) && JSON.stringify(existing[k]) !== JSON.stringify(newSchema[k]));

  // Safe automatic migration: only allow additive changes automatically
  if (removed.length === 0 && typeChanged.length === 0) {
    if (added.length === 0) return { applied: false, reason: 'no_changes' };
    // apply additive changes
    const newVersion = existingVersion + 1;
    await pool.query('UPDATE table_schemas SET schema=$1, schema_version=$2 WHERE tenant_id=$3 AND table_name=$4', [JSON.stringify(newSchema), newVersion, tenantId, tableName]);
    return { applied: true, reason: 'additive', added };
  }

  // If there are removals or type changes, be conservative
  const msg = `Migration required for tenant ${tenantId} table ${tableName}. Added: ${JSON.stringify(added)}, Removed: ${JSON.stringify(removed)}, TypeChanges: ${JSON.stringify(typeChanged)}. Destructive: ${options.destructive ? 'yes' : 'no'}`;
  await pool.query('INSERT INTO migration_logs(tenant_id, table_name, message) VALUES($1, $2, $3)', [tenantId, tableName, msg]);

  if (options.destructive) {
    // apply destructive change: update schema and increment version
    const newVersion = existingVersion + 1;
    await pool.query('UPDATE table_schemas SET schema=$1, schema_version=$2 WHERE tenant_id=$3 AND table_name=$4', [JSON.stringify(newSchema), newVersion, tenantId, tableName]);
    await pool.query('INSERT INTO migration_logs(tenant_id, table_name, message) VALUES($1, $2, $3)', [tenantId, tableName, `Destructive migration applied: ${msg}`]);
    return { applied: true, reason: 'destructive', added, removed, typeChanged };
  }

  return { applied: false, reason: 'requires_action', added, removed, typeChanged };
}

export async function pruneFieldFromRows(tenantId: string, tableName: string, fieldName: string) {
  // Remove field key from JSONB data for all rows in the table/tenant
  await pool.query(`UPDATE rows SET data = data - $1 WHERE tenant_id=$2 AND table_name=$3`, [fieldName, tenantId, tableName]);
  await pool.query('INSERT INTO migration_logs(tenant_id, table_name, message) VALUES($1, $2, $3)', [tenantId, tableName, `Pruned field ${fieldName} from rows`]);
  return { applied: true };
}

export async function copyFieldForRows(tenantId: string, tableName: string, fromField: string, toField: string) {
  // Copy value from one JSON key to another when present
  // Use text[] parameter for path and copy raw text value into new key
  if (!/^[a-zA-Z0-9_]+$/.test(fromField) || !/^[a-zA-Z0-9_]+$/.test(toField)) throw new Error('field names must be alphanumeric or underscore');
  await pool.query(`UPDATE rows SET data = jsonb_set(data, $1::text[], to_jsonb(data->>$2), true) WHERE tenant_id=$3 AND table_name=$4 AND data ? $2`, [[toField], fromField, tenantId, tableName]);
  await pool.query('INSERT INTO migration_logs(tenant_id, table_name, message) VALUES($1, $2, $3)', [tenantId, tableName, `Copied field ${fromField} -> ${toField}`]);
  return { applied: true };
}

export async function createIndexForField(tenantId: string, tableName: string, fieldName: string, fieldType: 'text' | 'number' = 'text') {
  if (!/^[a-zA-Z0-9_]+$/.test(fieldName)) throw new Error('field name must be alphanumeric or underscore');
  if (!/^[a-zA-Z0-9_\-]+$/.test(tenantId)) throw new Error('tenantId contains invalid characters');
  if (!/^[a-zA-Z0-9_\-]+$/.test(tableName)) throw new Error('tableName contains invalid characters');
  const idxName = `idx_${tenantId}_${tableName}_${fieldName}`.replace(/[^a-zA-Z0-9_]/g, '_');
  // Build SQL by embedding tenant/table as literals after validation (safer in this controlled env)
  let sql;
  if (fieldType === 'text') {
    sql = `CREATE INDEX IF NOT EXISTS ${idxName} ON rows ((data->>'${fieldName}')) WHERE tenant_id='${tenantId}' AND table_name='${tableName}'`;
  } else {
    sql = `CREATE INDEX IF NOT EXISTS ${idxName} ON rows (((data->>'${fieldName}')::numeric)) WHERE tenant_id='${tenantId}' AND table_name='${tableName}'`;
  }
  await pool.query(sql);
  await pool.query('INSERT INTO migration_logs(tenant_id, table_name, message) VALUES($1, $2, $3)', [tenantId, tableName, `Created index for ${fieldName} (${fieldType})`]);
  return { applied: true, idxName };
}

function secretKey() {
  const material = process.env.DATASOURCE_CONFIG_KEY || process.env.ADMIN_API_KEY || 'dev-datasource-config-key';
  return crypto.createHash('sha256').update(material).digest();
}

function encryptSecretPayload(plaintext: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${encrypted.toString('base64')}.${tag.toString('base64')}`;
}

function decryptSecretPayload(encoded: string) {
  const [ivB64, encryptedB64, tagB64] = encoded.split('.');
  if (!ivB64 || !encryptedB64 || !tagB64) throw new Error('invalid encrypted payload');
  const iv = Buffer.from(ivB64, 'base64');
  const encrypted = Buffer.from(encryptedB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(), iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

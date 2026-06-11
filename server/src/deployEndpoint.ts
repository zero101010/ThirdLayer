import express from 'express';
import {
  migrateTableSchema,
  createTenant,
  upsertDeployedProject,
  registerSync,
  enqueueSyncRunRequest,
  upsertDatasourceConfig,
} from './pg';

const router = express.Router();

// Deploy a project: receive source code + metadata from developer
// Validate, create tables, register syncs, store source code
router.post('/deploy/project', async (req, res) => {
  const tenant = req.headers['x-tenant-id'] ? String(req.headers['x-tenant-id']) : 'default';
  const { name, sourceCode, tables, syncs } = req.body || {};

  if (!name) return res.status(400).json({ error: 'name required' });
  if (!sourceCode) return res.status(400).json({ error: 'sourceCode required' });
  if (!Array.isArray(tables)) return res.status(400).json({ error: 'tables array required' });
  if (!Array.isArray(syncs)) return res.status(400).json({ error: 'syncs array required' });

  try {
    console.log(`API: Deploying project ${tenant}/${name}`);

    // Create/migrate tables
    const results: any[] = [];
    for (const t of tables) {
      if (!t.name || !t.primaryKey || !t.schema) {
        return res.status(400).json({ error: `Invalid table: ${t.name} missing required fields` });
      }
      const r = await migrateTableSchema(tenant, t.name, t.primaryKey, t.schema, { destructive: !!req.query.destructive });
      results.push({ table: t.name, result: r });
    }

    // Register syncs in metadata
    for (const s of syncs) {
      if (!s.name || !s.table || !s.mode) {
        return res.status(400).json({ error: `Invalid sync: ${s.name} missing required fields` });
      }
      await registerSync(tenant, name, s.name, {
        table: s.table,
        mode: s.mode,
        datasource: s.datasource,
        schedule: s.schedule,
      });
    }

    // Store project with source code
    await upsertDeployedProject(tenant, name, sourceCode);

    res.json({
      tenant,
      name,
      tables: results,
      syncs: syncs.map((s: any) => s.name),
    });
  } catch (e) {
    console.error(`API: Deploy failed for ${tenant}/${name}:`, e);
    return res.status(400).json({ error: `Failed to deploy project: ${String(e)}` });
  }
});

// Manually run a sync (used for unscheduled/manual syncs).
router.post('/syncs/run', async (req, res) => {
  const tenant = req.headers['x-tenant-id'] ? String(req.headers['x-tenant-id']) : 'default';
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const queued = await enqueueSyncRunRequest(tenant, name);
  res.status(202).json({ queued: true, request: queued });
});

// Create tenant and manage tenant API keys (admin only)
router.post('/tenants', async (req, res) => {
  const { tenantId } = req.body;
  if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
  const r = await createTenant(tenantId);
  res.json(r);
});

router.post('/datasources/:provider', async (req, res) => {
  const tenant = req.headers['x-tenant-id'] ? String(req.headers['x-tenant-id']) : null;
  const provider = req.params.provider;
  const config = req.body?.config;
  if (!tenant) return res.status(400).json({ error: 'x-tenant-id required' });
  if (!provider) return res.status(400).json({ error: 'provider required' });
  if (!config || typeof config !== 'object' || Array.isArray(config)) return res.status(400).json({ error: 'config object required' });
  const saved = await upsertDatasourceConfig(tenant, provider, config);
  res.json({ saved: true, ...saved });
});

export default router;

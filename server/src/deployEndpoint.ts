import express from 'express';
import path from 'path';
import {
  migrateTableSchema,
  createTenant,
  upsertDeployedProject,
  enqueueSyncRunRequest,
  upsertDatasourceConfig,
} from './pg';

const router = express.Router();

// Deploy a project description (tables array) to the platform
router.post('/deploy', async (req, res) => {
  const project = req.body;
  const tenant = req.headers['x-tenant-id'] ? String(req.headers['x-tenant-id']) : 'default';
  if (!project || !project.tables) return res.status(400).json({ error: 'project.tables required' });
  const results: any = [];
  for (const t of project.tables) {
    const r = await migrateTableSchema(tenant, t.name, t.primaryKey, t.schema, { destructive: !!req.query.destructive });
    results.push({ table: t.name, result: r });
  }
  res.json({ results });
});

// Deploy a code project by module path.
router.post('/deploy/project', async (req, res) => {
  const tenant = req.headers['x-tenant-id'] ? String(req.headers['x-tenant-id']) : 'default';
  const { name, modulePath } = req.body || {};
  if (!name || !modulePath) return res.status(400).json({ error: 'name and modulePath required' });

  const resolved = path.isAbsolute(modulePath) ? modulePath : path.resolve(process.cwd(), modulePath);
  // Reset authoring registry so each module is loaded in isolation.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sdk = require('../../packages/authoring-sdk/src');
  if (typeof sdk?.resetProjectRegistry === 'function') sdk.resetProjectRegistry();
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete require.cache[require.resolve(resolved)];
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const loaded = require(resolved);
  const project = loaded?.project;
  if (!project || !Array.isArray(project.tables) || !Array.isArray(project.syncs)) {
    return res.status(400).json({ error: 'module must export { project } with tables and syncs arrays' });
  }

  const results: any[] = [];
  for (const t of project.tables) {
    const r = await migrateTableSchema(tenant, t.name, t.primaryKey, t.schema, { destructive: !!req.query.destructive });
    results.push({ table: t.name, result: r });
  }
  await upsertDeployedProject(tenant, name, resolved);
  res.json({ tenant, name, modulePath: resolved, tables: results, syncs: project.syncs.map((s: any) => s.name) });
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

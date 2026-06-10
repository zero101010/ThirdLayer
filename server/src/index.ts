import express from 'express';
import bodyParser from 'body-parser';
import fs from 'fs';
import path from 'path';
import { upsertRow, replaceRow, deleteRow, getRow, queryRows, SchemaValidationError } from './db';
import { initDb, verifyTenantKey } from './pg';

const app = express();
app.use(bodyParser.json());

function resolveOpenApiPath() {
  const candidates = [
    path.resolve(__dirname, '../openapi.yaml'),
    path.resolve(process.cwd(), 'server/openapi.yaml'),
    path.resolve(process.cwd(), 'dist/server/openapi.yaml'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('openapi.yaml not found');
}

app.get(['/docs', '/docs/'], (_req, res) => {
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ThirdLayer API Docs</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
    <style>body{margin:0}#swagger-ui{min-height:100vh}</style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({ url: '/docs/openapi.yaml', dom_id: '#swagger-ui' });
    </script>
  </body>
</html>`;
  res.type('html').send(html);
});

app.get('/docs/openapi.yaml', (_req, res) => {
  const filePath = resolveOpenApiPath();
  res.type('application/yaml').sendFile(filePath);
});

// Dev-friendly CORS for Swagger/UI usage.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-tenant-id, x-tenant-key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

// simple API key auth and tenant extraction middleware
const ADMIN_KEY = process.env.ADMIN_API_KEY || 'admin-secret';
const ADMIN_ROUTE_PREFIXES = ['/v1/deploy', '/v1/syncs', '/v1/tenants', '/v1/datasources'];

function isAdminRoute(path: string) {
  return ADMIN_ROUTE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

app.use(async (req, res, next) => {
  try {
    // Admin routes require admin bearer key.
    if (isAdminRoute(req.path)) {
      const auth = req.headers['authorization'] ? String(req.headers['authorization']).replace(/^Bearer\s+/, '') : null;
      if (auth !== ADMIN_KEY) return res.status(401).json({ error: 'unauthorized' });
      return next();
    }

    // protect public v1 endpoints with tenant credentials
    if (req.path.startsWith('/v1')) {
      const tenant = req.headers['x-tenant-id'] ? String(req.headers['x-tenant-id']) : null;
      const tenantKey = req.headers['x-tenant-key'] ? String(req.headers['x-tenant-key']) : null;
      if (!tenant || !tenantKey) return res.status(401).json({ error: 'tenant authentication required' });
      const ok = await verifyTenantKey(tenant, tenantKey);
      if (!ok) return res.status(401).json({ error: 'invalid tenant credentials' });
      // attach tenant to request
      (req as any).tenantId = tenant;
    }
    return next();
  } catch (e) {
    console.error('auth middleware error', e);
    return res.status(500).json({ error: 'internal' });
  }
});

// deploy endpoint
import deployRouter from './deployEndpoint';
app.use('/v1', deployRouter);

app.post('/v1/tables/:table/query', async (req, res) => {
  const table = req.params.table;
  const tenant = req.headers['x-tenant-id'] ? String(req.headers['x-tenant-id']) : 'default';
  const { filter, sorts, page_size, start_cursor } = req.body || {};
  const q = await queryRows(tenant, table, { filter, sorts, page_size, start_cursor });
  res.json(q);
});

app.get('/v1/tables/:table/rows/:key', async (req, res) => {
  const tenant = req.headers['x-tenant-id'] ? String(req.headers['x-tenant-id']) : 'default';
  const row = await getRow(tenant, req.params.table, req.params.key);
  if (!row) return res.status(404).send({ error: 'not found' });
  res.json(row);
});

app.post('/v1/tables/:table/rows', async (req, res) => {
  const tenant = req.headers['x-tenant-id'] ? String(req.headers['x-tenant-id']) : 'default';
  const table = req.params.table;
  const { key, values } = req.body;
  try {
    await upsertRow(tenant, table, key, values);
    res.status(201).json({ key });
  } catch (e: any) {
    if (e instanceof SchemaValidationError) return res.status(400).json({ error: e.message, details: e.details });
    console.error('create row failed', e);
    return res.status(500).json({ error: 'internal' });
  }
});

app.patch('/v1/tables/:table/rows/:key', async (req, res) => {
  const tenant = req.headers['x-tenant-id'] ? String(req.headers['x-tenant-id']) : 'default';
  const { table, key } = req.params;
  const { values } = req.body;
  try {
    await upsertRow(tenant, table, key, values);
    res.json({ key });
  } catch (e: any) {
    if (e instanceof SchemaValidationError) return res.status(400).json({ error: e.message, details: e.details });
    console.error('update row failed', e);
    return res.status(500).json({ error: 'internal' });
  }
});

app.put('/v1/tables/:table/rows/:key', async (req, res) => {
  const tenant = req.headers['x-tenant-id'] ? String(req.headers['x-tenant-id']) : 'default';
  const { table, key } = req.params;
  const { values } = req.body;
  try {
    await replaceRow(tenant, table, key, values);
    res.json({ key });
  } catch (e: any) {
    if (e instanceof SchemaValidationError) return res.status(400).json({ error: e.message, details: e.details });
    console.error('replace row failed', e);
    return res.status(500).json({ error: 'internal' });
  }
});

app.delete('/v1/tables/:table/rows/:key', async (req, res) => {
  const tenant = req.headers['x-tenant-id'] ? String(req.headers['x-tenant-id']) : 'default';
  await deleteRow(tenant, req.params.table, req.params.key);
  res.status(204).send(null);
});

async function start() {
  await initDb();

  const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
  app.listen(port, () => console.log(`Server listening on http://localhost:${port}`));
}

start().catch((e) => {
  console.error('Failed to start server', e);
  process.exit(1);
});

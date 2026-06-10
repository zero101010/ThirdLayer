ThirdLayer takehome - TypeScript platform + SDK

## Services

1. **Server service** (`npm run start:server`)  
   Hosts both public table API and internal/admin endpoints.
   Public table API:
   - `POST /v1/tables/:table/query`
   - `GET /v1/tables/:table/rows/:key`
   - `POST /v1/tables/:table/rows`
   - `PATCH /v1/tables/:table/rows/:key`
   - `PUT /v1/tables/:table/rows/:key`
   - `DELETE /v1/tables/:table/rows/:key`

2. **Worker service** (`npm run start:worker`)  
   Loads project sync definitions and runs/schedules sync execution loops.

## OpenAPI (Swagger)

OpenAPI spec: `server/openapi.yaml`

Swagger UI (from the running server): `http://localhost:3000/docs`

## Quickstart

1. `npm install`
2. Start Postgres and set `.env` (`DATABASE_URL`).
3. Start server service: `npm run start:server`
4. Create a tenant key from admin API.
5. Deploy one or more code projects.
6. Start worker: `npm run start:worker`

## Deploy flow

1. Create tenant API key:

```bash
curl -s -X POST http://localhost:3000/v1/tenants \
  -H "Authorization: Bearer admin-secret" \
  -H "Content-Type: application/json" \
  -d '{"tenantId":"acme"}'
```

If `tenantId` already exists, this endpoint keeps the existing key and does not rotate/reissue it.

2. (Recommended) set tenant datasource config for GitHub:

```bash
curl -s -X POST http://localhost:3000/v1/datasources/github \
  -H "Authorization: Bearer admin-secret" \
  -H "x-tenant-id: acme" \
  -H "Content-Type: application/json" \
  -d '{"config":{"token":"<github-token>","owner":"octocat","repo":"Hello-World"}}'
```

3. Deploy a project module path (server migrates table schemas and worker loads/runs syncs):

```bash
curl -s -X POST http://localhost:3000/v1/deploy/project \
  -H "Authorization: Bearer admin-secret" \
  -H "x-tenant-id: acme" \
  -H "Content-Type: application/json" \
  -d '{"name":"github-sync","modulePath":"examples/github-sync/project.ts"}'
```

4. Optionally deploy a second project:

```bash
curl -s -X POST http://localhost:3000/v1/deploy/project \
  -H "Authorization: Bearer admin-secret" \
  -H "x-tenant-id: acme" \
  -H "Content-Type: application/json" \
  -d '{"name":"github-prs","modulePath":"examples/github-prs/project.ts"}'
```

5. Run one sync manually (for unscheduled/manual syncs):

```bash
curl -s -X POST http://localhost:3000/v1/syncs/run \
  -H "Authorization: Bearer admin-secret" \
  -H "x-tenant-id: acme" \
  -H "Content-Type: application/json" \
  -d '{"name":"github-prs"}'
```

### One-command deploy + run

You can run the full flow (tenant -> datasource config -> deploy -> sync enqueue) with one command:

```bash
npm run run:project -- \
  --tenant acme \
  --module-path examples/github-sync/project.ts \
  --project-name github-sync \
  --github-token <github-token> \
  --owner octocat \
  --repo Hello-World
```

Notes:
- Requires server and worker running.
- Uses `ADMIN_API_KEY` from `.env` by default (or pass `--admin-key`).
- Tenant creation is idempotent: existing tenant IDs keep their current key.
- Use `--sync-name <name>` to choose which sync to enqueue.
- If tenant already exists, pass `--tenant-key` (or `TENANT_KEY`) to print query examples.
- Use `--skip-sync` if you only want tenant/datasource/deploy.
- These admin API calls are available from `packages/authoring-sdk/src` via `ThirdLayerAdminApi` (`createTenant`, `setDatasourceConfig`, `deployProject`, `enqueueSync`).

## Included example projects

- `examples/github-sync/project.ts` (replace sync from live GitHub Issues API)
- `examples/github-prs/project.ts` (incremental sync from live GitHub Pull Requests API with cursor state)
- `examples/get-issues.ts` (standalone script that fetches latest GitHub issues as JSON)

Run the standalone issues fetch example:

```bash
npx ts-node examples/get-issues.ts
```

Run `examples/github-prs/project.ts` directly as a single-file flow (tenant -> datasource -> deploy -> sync):

```bash
npx ts-node examples/github-prs/project.ts \
  --tenant acme \
  --admin-key admin-secret \
  --tenant-key <existing-tenant-key> \
  --github-token <github-token> \
  --owner octocat \
  --repo Hello-World
```

### GitHub example configuration

Set these env vars to point the examples at a repository:

- `GITHUB_OWNER` / `GITHUB_REPO` (defaults: `octocat` / `Hello-World`)
- `GITHUB_TOKEN` is strongly recommended to avoid GitHub unauthenticated rate limits
- Per-tenant datasource config (`POST /v1/datasources/github`) is preferred for multi-tenant usage; env vars are fallback defaults
- Optional overrides per example:
  - `GITHUB_ISSUES_OWNER` / `GITHUB_ISSUES_REPO`
  - `GITHUB_PRS_OWNER` / `GITHUB_PRS_REPO`
- Optional encryption key override for datasource config storage:
  - `DATASOURCE_CONFIG_KEY` (if omitted, falls back to `ADMIN_API_KEY`)

## Design trade-offs

- **Row data in JSONB**: maximizes flexible per-table schemas and fast iteration. Trade-off is weaker DB-level typing/constraints on each property; we compensate with schema metadata and expression indexes.
- **Single Postgres schema with `tenant_id` columns**: aligns with "no schema-per-tenant", keeps operations simple, and supports cross-tenant admin tooling. Trade-off is strict need to enforce tenant predicates in every query.
- **Replace migrations are explicit**: additive schema changes auto-apply, while removals/type changes require destructive intent and an explicit migration plan. Trade-off is extra operational steps, but safer data lifecycle.
- **In-process scheduler worker**: simple runtime model (one worker process) with persisted sync state and manual run queue in Postgres. Trade-off is no distributed locking/lease model yet for multi-worker horizontal scaling.

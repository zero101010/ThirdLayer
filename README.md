# ThirdLayer

Multi-tenant platform that lets developers define flexible tables, sync data from external sources (GitHub, Linear), and query data through a REST API and typed Client SDK.

This is a Vídeo that shows and explain the full structure and how to run

https://www.loom.com/share/abfc5c6d6bfc4be2a561e9db87918c11

This is other video that shows how to query with the SDK

https://www.loom.com/share/ba7d1f6921d94204a02b5b46c482c7b8


## Architecture

```
DEVELOPER'S MACHINE                        HOSTED PLATFORM (Docker)
+----------------------------+        +----------------------------------+
|                            |        |                                  |
|  project.ts                |        |   +------------------------+    |
|    table(), field, sync()  | deploy |   |   API Server (:3000)   |    |
|    deploy()  ---------------------->|   |   - Admin routes       |    |
|                            |        |   |   - Public query API   |    |
|  .env                      |        |   +------------------------+    |
|    GITHUB_TOKEN, etc.      |        |              |                  |
|                            |        |              v                  |
|  query-*.ts                |        |   +------------------------+    |
|    Client SDK  ---------------------->  |   PostgreSQL 16        |    |
|    query(), getRow()       |        |   |   - Schemas, rows      |    |
|                            |        |   |   - Sync queue         |    |
+----------------------------+        |   +------------------------+    |
                                      |              ^                  |
                                      |   +------------------------+    |
                                      |   |   Worker               |    |
                                      |   |   - Scheduled syncs    |    |
                                      |   |   - Enqueued syncs     |    |
                                      |   |   - Auto-migration     |    |
                                      |   +------------------------+    |
                                      +----------------------------------+
```

### Services

| Service | Description |
|---------|-------------|
| **API Server** | Express server on port 3000. Hosts admin routes (`/v1/deploy/*`, `/v1/tenants`, `/v1/syncs/*`, `/v1/datasources/*`) and public query routes (`/v1/tables/*/query`, `/v1/tables/*/rows/*`). Admin routes require `Authorization: Bearer <ADMIN_API_KEY>`. Public routes require `x-tenant-id` + `x-tenant-key` headers. |
| **Worker** | Background service that polls the database every 5 seconds. Processes enqueued sync requests from the `sync_run_requests` table and runs scheduled syncs based on each sync's `schedule` interval. Auto-migrates table schemas when source code changes are detected. |
| **PostgreSQL** | Stores all platform state: tenant credentials, table schemas, row data (JSONB), sync definitions, sync state/cursors, deployed project source code, datasource configs (AES-256-GCM encrypted), and the sync run queue. |

### SDKs

| Package | Purpose | Used by |
|---------|---------|---------|
| **authoring-sdk** (`packages/authoring-sdk/src`) | Define tables, syncs, connectors. Deploy projects. | Developer project files + Worker |
| **client-sdk** (`packages/client-sdk/src`) | Query, read, and write row data. | End-user applications |

## Prerequisites

- **Node.js** >= 20
- **Docker** and **Docker Compose** (for containerized setup)
- **npm** (comes with Node.js)

## Quickstart with Docker Compose

### 1. Create the root `.env` file

```bash
cp .env.example .env
```

The root `.env` is used by the API and Worker containers. Default values:

```env
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/thirdlayer
ADMIN_API_KEY=admin-secret
DATASOURCE_CONFIG_KEY=dev-datasource-config-key
```

### 2. Start all services

```bash
docker compose up -d
```

This starts three containers:
- `thirdlayer-postgres` on port 5432
- `thirdlayer-api` on port 3000
- `thirdlayer-worker` processing syncs in the background

### 3. Install local dependencies (for running examples)

```bash
npm install
```

### 4. Configure an example

Each example has a `.env.example` template. Copy and fill it in:

```bash
cp examples/github-issues/.env.example examples/github-issues/.env
```

Edit the `.env` with your values:

```env
THIRDLAYER_BASE_URL=http://localhost:3000
ADMIN_API_KEY=admin-secret
TENANT_ID=your-tenant-name
PROJECT_NAME=github-issues
GITHUB_TOKEN=ghp_your_token_here
GITHUB_OWNER=octocat
GITHUB_REPO=Hello-World
```

### 5. Deploy a project

```bash
npx ts-node examples/github-issues/project.ts
```

Output shows the 4-step flow:
1. Creates/verifies tenant
2. Configures datasource credentials (auto-detected from `.env`)
3. Deploys project (migrates schema, stores source code)
4. Enqueues initial sync

On first deploy, the `TENANT_KEY` is automatically saved to the project's `.env` file. For subsequent examples sharing the same `TENANT_ID`, the key is read from the environment and saved to each project's `.env` automatically.

### 6. Query data

Add `TENANT_KEY=<your-key>` to the example's `.env`, then:

```bash
npx ts-node examples/github-issues/query-github-issues.ts
```

## Running without Docker

```bash
# 1. Start Postgres (set DATABASE_URL in root .env)
# 2. Start API server
npm run start:server

# 3. Start worker (separate terminal)
npm run start:worker

# 4. Deploy and query examples as above
```

## Examples

Each example directory contains:
- `project.ts` -- table + sync definition and deploy script
- `query-*.ts` -- Client SDK query examples
- `.env.example` -- configuration template
- `.env` -- your local configuration (git-ignored)

### GitHub Issues (`examples/github-issues/`)

Syncs issues from a GitHub repository. Table: `issues` with fields: id, title, state, comments, createdAt, isUrgent.

```bash
# Deploy
npx ts-node examples/github-issues/project.ts

# Query
npx ts-node examples/github-issues/query-github-issues.ts
```

Required env vars: `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`

### GitHub Pull Requests (`examples/github-prs/`)

Syncs pull requests from a GitHub repository. Table: `pull_requests` with fields: id, title, author, state, labels, isDraft, updatedAt.

```bash
# Deploy
npx ts-node examples/github-prs/project.ts

# Query
npx ts-node examples/github-prs/query-github-prs.ts
```

Required env vars: `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`

### Linear Issues (`examples/linear-issues/`)

Syncs issues from Linear via GraphQL. Table: `linear_issues` with fields: id, title, state, assignee, priority, labels, createdAt, updatedAt, isUrgent.

```bash
# Deploy
npx ts-node examples/linear-issues/project.ts

# Query
npx ts-node examples/linear-issues/query-linear-issues.ts
```

Required env vars: `LINEAR_API_KEY`

### Generic Client Query (`examples/client-query.ts`)

Standalone query script. Requires `TENANT_ID` and `TENANT_KEY` env vars or edits in the file.

```bash
npx ts-node examples/client-query.ts
```

## Database Structure

All data lives in a single Postgres database. Multi-tenancy is enforced with `tenant_id` columns on every table.

```
+-------------------+     +-------------------+     +-------------------+
|     tenants       |     |   table_schemas   |     |       rows        |
+-------------------+     +-------------------+     +-------------------+
| tenant_id (PK)    |<--->| tenant_id (PK)    |<--->| tenant_id (PK)    |
| api_key_hash      |     | table_name (PK)   |     | table_name (PK)   |
| created_at        |     | primary_key       |     | key (PK)          |
+-------------------+     | schema (JSONB)    |     | data (JSONB)      |
                          | schema_version    |     | updated_at        |
                          | created_at        |     +-------------------+
                          +-------------------+
                                                    +-------------------+
+-------------------+     +-------------------+     | sync_run_requests |
| deployed_projects |     |  syncs_metadata   |     +-------------------+
+-------------------+     +-------------------+     | id (PK)           |
| tenant_id (PK)    |     | tenant_id (PK)    |     | tenant_id         |
| name (PK)         |<--->| sync_name (PK)    |     | sync_name         |
| source_code       |     | table_name        |     | status            |
| enabled           |     | mode              |     | error             |
| created_at        |     | datasource        |     | created_at        |
| updated_at        |     | schedule          |     | updated_at        |
+-------------------+     | project_name      |     +-------------------+
                          | created_at        |
+-------------------+     | updated_at        |     +-------------------+
|   sync_states     |     +-------------------+     | datasource_configs|
+-------------------+                               +-------------------+
| tenant_id (PK)    |     +-------------------+     | tenant_id (PK)    |
| sync_name (PK)    |     |  migration_logs   |     | provider (PK)     |
| state (JSONB)     |     +-------------------+     | config_encrypted  |
| updated_at        |     | id (PK)           |     | config_hash       |
+-------------------+     | tenant_id         |     | created_at        |
                          | table_name        |     | updated_at        |
                          | created_at        |     +-------------------+
                          | message           |
                          +-------------------+
```

### Table Descriptions

| Table | Purpose |
|-------|---------|
| **tenants** | Registered tenants with hashed API keys for authentication. |
| **table_schemas** | Schema definitions per tenant/table. Stores field types as JSONB. Versioned for migration tracking. |
| **rows** | All row data across all tenants and tables. Data stored as JSONB for flexible schemas. Composite PK: `(tenant_id, table_name, key)`. |
| **deployed_projects** | Stored TypeScript source code for each project. The worker loads and executes this to run syncs. |
| **syncs_metadata** | Sync configuration: which table, mode (replace/incremental), datasource, schedule interval, parent project. |
| **sync_states** | Persisted pagination state (cursors, page numbers) for each sync. Allows syncs to resume across restarts. |
| **sync_run_requests** | Database-backed queue for sync execution. Status transitions: `pending` -> `running` -> `done`/`failed`. |
| **datasource_configs** | Encrypted credentials (AES-256-GCM) for external APIs (GitHub tokens, Linear API keys). Per-tenant per-provider. |
| **migration_logs** | Audit trail of all schema migrations (additive and destructive). |

### Sync Queue

The platform uses a **Postgres-backed polling queue** instead of a message broker (RabbitMQ, Redis, etc.):

1. When a project is deployed, `sync_run_requests` gets a row with `status = 'pending'`
2. The worker polls every 5 seconds, claims pending requests by setting `status = 'running'`
3. After execution, status is set to `done` or `failed` (with error details)
4. Scheduled syncs work separately: the worker compares `sync_states.updated_at` against the sync's schedule interval and runs when due

This approach keeps the stack simple (no extra infrastructure) and is sufficient for the expected workload. For high-throughput scenarios, this could be replaced with RabbitMQ or a Redis-based queue.

## Schema Migrations

Schema changes are handled automatically when you redeploy:

- **Additive changes** (new fields): applied automatically
- **Destructive changes** (removed/changed fields): applied when `destructive: true` is set in `deploy()` options. Removed fields are pruned from all existing rows.
- The worker auto-migrates schemas before each sync run, so changes take effect immediately.

```typescript
// In project.ts -- destructive: true enables auto-removal of dropped fields
deploy({ projectName: 'github-issues', destructive: true })
```

## API Endpoints

### Admin Routes (require `Authorization: Bearer <ADMIN_API_KEY>`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/v1/tenants` | Create a tenant (returns API key) |
| POST | `/v1/deploy/project` | Deploy a project (schema + source code) |
| POST | `/v1/syncs/run` | Manually enqueue a sync run |
| POST | `/v1/datasources/:provider` | Set datasource credentials |

### Public Routes (require `x-tenant-id` + `x-tenant-key`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/v1/tables/:table/query` | Query rows with filters, sorts, pagination |
| GET | `/v1/tables/:table/rows/:key` | Get a single row |
| POST | `/v1/tables/:table/rows` | Create a row |
| PATCH | `/v1/tables/:table/rows/:key` | Update a row (partial) |
| PUT | `/v1/tables/:table/rows/:key` | Replace a row |
| DELETE | `/v1/tables/:table/rows/:key` | Delete a row |

Swagger UI available at: `http://localhost:3000/docs`

## Design Trade-offs

- **JSONB for row data**: Flexible per-table schemas without DDL. Trade-off is weaker DB-level typing; compensated with schema validation on write and schema filtering on read.
- **Single Postgres schema with `tenant_id`**: No schema-per-tenant complexity. Requires strict tenant predicates in every query.
- **Source code stored in DB**: The worker executes project source from `deployed_projects`, not from the filesystem. Enables deploys without filesystem access.
- **Postgres queue over message broker**: One fewer service to run. Sufficient for current scale. Can be swapped for RabbitMQ/Redis if needed.
- **Worker auto-migration**: Schema changes are applied before sync execution, preventing validation errors when project code changes.

// Authoring SDK - declarative API for tables and syncs
export type FieldType =
  | { kind: 'text' }
  | { kind: 'number' }
  | { kind: 'boolean' }
  | { kind: 'datetime' }
  | { kind: 'select'; options: string[] }
  | { kind: 'multiSelect' };

export type SchemaSpec = Record<string, FieldType>;

export type TableDef = {
  name: string;
  primaryKey: string;
  schema: SchemaSpec;
};

export type Change =
  | { type: 'upsert'; key: string; values: Record<string, any> }
  | { type: 'delete'; key: string };

export type SyncResult<S = any> = {
  changes: Change[];
  hasMore: boolean;
  nextState?: S;
};

export type SyncExecutionContext = {
  tenant: string;
  datasource?: Record<string, any>;
};

export type SyncDef<S = any> = {
  table: TableDef;
  mode: 'replace' | 'incremental';
  datasource?: string;
  schedule?: string; // e.g. "5m"
  execute: (state?: S, context?: SyncExecutionContext) => Promise<SyncResult<S>>;
};

export type RegisteredSync<S = any> = SyncDef<S> & { name: string };

// In-memory registry that a deployer can import to find tables & syncs declared by a project
export const project = {
  tables: [] as TableDef[],
  syncs: [] as RegisteredSync[],
};

export function resetProjectRegistry() {
  project.tables.length = 0;
  project.syncs.length = 0;
}

export function table(name: string, opts: { primaryKey: string; schema: SchemaSpec }): TableDef {
  const t: TableDef = { name, primaryKey: opts.primaryKey, schema: opts.schema };
  project.tables.push(t);
  return t;
}

export const field = {
  text: (): FieldType => ({ kind: 'text' }),
  number: (): FieldType => ({ kind: 'number' }),
  boolean: (): FieldType => ({ kind: 'boolean' }),
  datetime: (): FieldType => ({ kind: 'datetime' }),
  select: (options: string[]): FieldType => ({ kind: 'select', options }),
  multiSelect: (): FieldType => ({ kind: 'multiSelect' }),
};

export function sync<S = any>(name: string, def: SyncDef<S>): RegisteredSync<S> {
  const s: RegisteredSync<S> = { ...def, name } as RegisteredSync<S>;
  project.syncs.push(s);
  return s;
}

// ============================================================================
// GITHUB CONNECTOR - helpers for GitHub API syncs
// ============================================================================

type GitHubRepo = { owner: string; repo: string };

export function getGitHubRepo(prefix: string, context?: SyncExecutionContext): GitHubRepo {
  const owner =
    context?.datasource?.owner || process.env[`${prefix}_OWNER`] || process.env.GITHUB_OWNER || 'octocat';
  const repo =
    context?.datasource?.repo || process.env[`${prefix}_REPO`] || process.env.GITHUB_REPO || 'Hello-World';
  return { owner, repo };
}

export class GitHubApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, message: string, body: string) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
    this.body = body;
  }
}

export async function githubGet<T>(url: string, context?: SyncExecutionContext): Promise<{ data: T; link: string | null }> {
  const fetchFn = resolveFetchForConnectors();
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'thirdlayer-takehome',
  };
  const token = context?.datasource?.token || process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetchFn(url, { headers });
  if (!res.ok) {
    const body = await res.text();
    const remaining = res.headers?.get?.('x-ratelimit-remaining');
    const resetRaw = res.headers?.get?.('x-ratelimit-reset');
    const resetAt =
      resetRaw && /^\d+$/.test(resetRaw) ? new Date(Number(resetRaw) * 1000).toISOString() : undefined;

    if (res.status === 403 && remaining === '0') {
      throw new GitHubApiError(
        403,
        `GitHub API rate limit exceeded. Set GITHUB_TOKEN for authenticated requests.${
          resetAt ? ` Limit resets at ${resetAt}.` : ''
        }`,
        body
      );
    }

    if (res.status === 422 && body.includes('Pagination with the page parameter is not supported')) {
      throw new GitHubApiError(
        422,
        'This repository is too large for this page-based example.',
        body
      );
    }

    throw new GitHubApiError(res.status, `GitHub request failed (${res.status})`, body);
  }
  return { data: (await res.json()) as T, link: res.headers?.get?.('link') ?? null };
}

export function hasNextFromLink(link: string | null): boolean {
  if (!link) return false;
  return link.split(',').some((part) => part.includes('rel="next"'));
}

export function bumpCursorTimestamp(ts: string): string {
  const ms = new Date(ts).getTime();
  if (Number.isNaN(ms)) return ts;
  return new Date(Math.max(0, ms - 1000)).toISOString();
}

// ============================================================================
// LINEAR CONNECTOR - helpers for Linear API syncs (GraphQL)
// ============================================================================

export class LinearApiError extends Error {
  errors: any[];
  constructor(message: string, errors: any[]) {
    super(message);
    this.name = 'LinearApiError';
    this.errors = errors;
  }
}

export async function linearQuery<T = any>(
  query: string,
  variables: Record<string, any> = {},
  context?: SyncExecutionContext
): Promise<T> {
  const fetchFn = resolveFetchForConnectors();
  const token = context?.datasource?.token || process.env.LINEAR_API_KEY;
  if (!token) throw new Error('Linear API key required. Set LINEAR_API_KEY or configure the linear datasource.');

  const res = await fetchFn('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json();

  if (!res.ok || json.errors) {
    throw new LinearApiError(
      `Linear API error: ${json.errors?.[0]?.message ?? res.status}`,
      json.errors ?? []
    );
  }

  return json.data as T;
}

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<any>; headers: any }>;

declare const require: any;

function resolveFetchForConnectors(): FetchLike {
  const globalFetch = (globalThis as any).fetch;
  if (typeof globalFetch === 'function') return globalFetch.bind(globalThis) as FetchLike;
  if (typeof require !== 'undefined') return require('node-fetch') as FetchLike;
  throw new Error('fetch is not available; provide a global fetch or install node-fetch');
}

function resolveFetch(fetchImpl?: FetchLike): FetchLike {
  if (fetchImpl) return fetchImpl;
  const globalFetch = (globalThis as any).fetch;
  if (typeof globalFetch === 'function') return globalFetch.bind(globalThis) as FetchLike;
  if (typeof require !== 'undefined') return require('node-fetch') as FetchLike;
  throw new Error('fetch is not available; provide fetchImpl or install node-fetch');
}

function normalizeBaseUrl(baseUrl?: string): string {
  return (baseUrl || process.env.THIRDLAYER_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

async function parseJsonSafe(text: string): Promise<any> {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export type ThirdLayerAdminApiOptions = {
  baseUrl?: string;
  adminApiKey: string;
  fetchImpl?: FetchLike;
};

export type TenantCreateResponse = { tenantId: string; created: boolean; apiKey: string | null };
export type DatasourceConfig = Record<string, any>;
export type DatasourceSaveResponse = { saved: boolean; provider: string; hash: string };
export type DeployProjectResponse = {
  tenant: string;
  name: string;
  tables: Array<{ table: string; result: any }>;
  syncs: string[];
};

export type ProjectDeploymentRequest = {
  name: string;
  sourceCode: string;
  tables: TableDef[];
  syncs: Array<{ name: string; table: string; mode: string; datasource?: string; schedule?: string }>;
};

export class ThirdLayerAdminApi {
  private readonly baseUrl: string;
  private readonly adminApiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: ThirdLayerAdminApiOptions) {
    if (!opts?.adminApiKey) throw new Error('adminApiKey is required');
    this.baseUrl = normalizeBaseUrl(opts.baseUrl);
    this.adminApiKey = opts.adminApiKey;
    this.fetchImpl = resolveFetch(opts.fetchImpl);
  }

  private async postJson<T>(path: string, body: Record<string, any>, headers: Record<string, string> = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.adminApiKey}`,
        ...headers,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const payload = await parseJsonSafe(text);
    if (!res.ok) {
      throw new Error(`Request failed (${res.status}) POST ${url}: ${JSON.stringify(payload)}`);
    }
    return payload as T;
  }

  async createTenant(tenantId: string): Promise<TenantCreateResponse> {
    if (!tenantId) throw new Error('tenantId is required');
    return this.postJson<TenantCreateResponse>('/v1/tenants', { tenantId });
  }

  async setDatasourceConfig(tenantId: string, provider: string, config: DatasourceConfig): Promise<DatasourceSaveResponse> {
    if (!tenantId) throw new Error('tenantId is required');
    if (!provider) throw new Error('provider is required');
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('config object is required');
    return this.postJson<DatasourceSaveResponse>(`/v1/datasources/${encodeURIComponent(provider)}`, { config }, { 'x-tenant-id': tenantId });
  }

  async deployProject(tenantId: string, deployment: ProjectDeploymentRequest, opts?: { destructive?: boolean }): Promise<DeployProjectResponse> {
    if (!tenantId) throw new Error('tenantId is required');
    if (!deployment.name) throw new Error('deployment.name is required');
    if (!deployment.sourceCode) throw new Error('deployment.sourceCode is required');
    if (!Array.isArray(deployment.tables)) throw new Error('deployment.tables array is required');
    if (!Array.isArray(deployment.syncs)) throw new Error('deployment.syncs array is required');

    const qs = opts?.destructive ? '?destructive=true' : '';
    return this.postJson<DeployProjectResponse>(`/v1/deploy/project${qs}`, deployment, { 'x-tenant-id': tenantId });
  }

  async enqueueSync(tenantId: string, name: string): Promise<{ queued: boolean; request: any }> {
    if (!tenantId) throw new Error('tenantId is required');
    if (!name) throw new Error('name is required');
    return this.postJson<{ queued: boolean; request: any }>(
      '/v1/syncs/run',
      { name },
      { 'x-tenant-id': tenantId }
    );
  }
}

/**
 * Helper: Read a file as source code
 * Works with both absolute and relative paths
 */
export function readSourceCode(filename: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    const resolved = path.isAbsolute(filename) ? filename : path.resolve(process.cwd(), filename);
    return fs.readFileSync(resolved, 'utf-8');
  } catch (e) {
    throw new Error(`Failed to read source code from ${filename}: ${String(e)}`);
  }
}

/**
 * Helper: Create a project deployment from the current project state
 * Call this after all tables and syncs are defined
 */
export function createDeployment(name: string, sourceCode: string): ProjectDeploymentRequest {
  return {
    name,
    sourceCode,
    tables: project.tables,
    syncs: project.syncs.map((s) => ({
      name: s.name,
      table: s.table.name,
      mode: s.mode,
      datasource: s.datasource,
      schedule: s.schedule,
    })),
  };
}

// ============================================================================
// DEPLOY - One-call deployment for developer project files
// ============================================================================

export type DatasourceEntry = {
  provider: string;
  config: Record<string, string>;
};

export type DeployOptions = {
  baseUrl?: string;
  adminKey?: string;
  tenant?: string;
  projectName?: string;
  datasources?: DatasourceEntry[];
  skipSync?: boolean;
  syncName?: string;
  sourceFile?: string;
  destructive?: boolean;
};

function resolveEnvDatasources(): DatasourceEntry[] {
  const datasources: DatasourceEntry[] = [];

  // GitHub datasource
  const githubToken = process.env.GITHUB_TOKEN;
  const githubOwner = process.env.GITHUB_OWNER;
  const githubRepo = process.env.GITHUB_REPO;
  if (githubToken && githubOwner && githubRepo) {
    datasources.push({
      provider: 'github',
      config: { token: githubToken, owner: githubOwner, repo: githubRepo },
    });
  }

  // Linear datasource
  const linearKey = process.env.LINEAR_API_KEY;
  if (linearKey) {
    datasources.push({
      provider: 'linear',
      config: { token: linearKey },
    });
  }

  // Slack datasource
  const slackToken = process.env.SLACK_TOKEN;
  if (slackToken) {
    datasources.push({
      provider: 'slack',
      config: { token: slackToken },
    });
  }

  return datasources;
}

/**
 * Deploy the current project to ThirdLayer.
 *
 * Handles tenant creation, datasource configuration, project deployment,
 * and sync enqueueing. Reads configuration from options or environment variables.
 *
 * Environment variables:
 *   ADMIN_API_KEY, THIRDLAYER_BASE_URL, TENANT_ID, PROJECT_NAME,
 *   GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, LINEAR_API_KEY, SLACK_TOKEN,
 *   SYNC_NAME, SKIP_SYNC
 */
export async function deploy(opts: DeployOptions = {}): Promise<void> {
  // Load .env from the project file's directory, then from CWD as fallback
  try {
    const dotenv = require('dotenv');
    const pathMod = require('path');
    const sourceFile = opts.sourceFile ?? (typeof require !== 'undefined' ? require.main?.filename : undefined);
    if (sourceFile) {
      dotenv.config({ path: pathMod.resolve(pathMod.dirname(sourceFile), '.env') });
    }
    dotenv.config(); // CWD fallback (won't override already-set vars)
  } catch { /* dotenv not installed, rely on existing env */ }

  const baseUrl = (opts.baseUrl ?? process.env.THIRDLAYER_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
  const adminKey = opts.adminKey ?? process.env.ADMIN_API_KEY;
  if (!adminKey) throw new Error('adminKey is required (pass in options or set ADMIN_API_KEY)');

  const tenantId = opts.tenant ?? process.env.TENANT_ID ?? 'acme';
  const projectName = opts.projectName ?? process.env.PROJECT_NAME ?? 'my-project';
  const skipSync = opts.skipSync ?? !!process.env.SKIP_SYNC;
  const syncName = opts.syncName ?? process.env.SYNC_NAME;

  // Merge datasources: explicit opts take priority, then env-based auto-detection
  const datasources = opts.datasources ?? resolveEnvDatasources();

  const api = new ThirdLayerAdminApi({ baseUrl, adminApiKey: adminKey });

  // 1. Create/get tenant
  console.log(`1/4 Creating tenant "${tenantId}"...`);
  const tenantResult = await api.createTenant(tenantId);
  console.log(tenantResult.created ? `  Created: ${tenantResult.tenantId}` : `  Exists: ${tenantResult.tenantId}`);

  // 2. Configure datasources
  console.log(`2/4 Configuring datasources...`);
  for (const ds of datasources) {
    await api.setDatasourceConfig(tenantId, ds.provider, ds.config);
    console.log(`  Configured ${ds.provider}`);
  }
  if (datasources.length === 0) {
    console.log(`  No datasources configured`);
  }

  // 3. Deploy project
  console.log(`3/4 Deploying project "${projectName}"...`);
  const sourceFile = opts.sourceFile ?? (typeof require !== 'undefined' ? require.main?.filename : undefined);
  if (!sourceFile) throw new Error('Could not determine source file. Pass sourceFile in deploy options.');
  const sourceCode = readSourceCode(sourceFile);
  const deployment = createDeployment(projectName, sourceCode);
  const deployResult = await api.deployProject(tenantId, deployment, { destructive: opts.destructive });
  for (const t of deployResult.tables) {
    const r = t.result;
    if (r?.reason === 'requires_action') {
      console.log(`  Table ${t.table}: schema change requires destructive deploy (removed: ${JSON.stringify(r.removed)}, changed: ${JSON.stringify(r.typeChanged)})`);
      console.log(`    Re-run with: deploy({ destructive: true })`);
    } else {
      console.log(`  Table ${t.table}: ${r?.reason ?? 'ok'}`);
    }
  }
  console.log(`  Syncs: ${deployResult.syncs.join(', ')}`);

  // 4. Enqueue sync
  if (!skipSync && datasources.length > 0) {
    const syncsToEnqueue = syncName ? [syncName] : deployResult.syncs;
    console.log(`4/4 Enqueueing syncs...`);
    for (const s of syncsToEnqueue) {
      await api.enqueueSync(tenantId, s);
      console.log(`  Enqueued ${s}`);
    }
  } else {
    console.log(`4/4 Skipping sync enqueue`);
  }

  console.log(`\nDone! Tenant: ${tenantId}`);
  if (tenantResult.apiKey) {
    console.log(`API Key: ${tenantResult.apiKey}`);

    // Auto-save TENANT_KEY to the project's .env so query scripts work immediately
    try {
      const fsMod = require('fs');
      const pathMod = require('path');
      const envPath = pathMod.resolve(pathMod.dirname(sourceFile), '.env');
      if (fsMod.existsSync(envPath)) {
        let envContent = fsMod.readFileSync(envPath, 'utf8');
        if (envContent.match(/^TENANT_KEY=/m)) {
          envContent = envContent.replace(/^TENANT_KEY=.*$/m, `TENANT_KEY=${tenantResult.apiKey}`);
        } else {
          envContent = envContent.trimEnd() + `\nTENANT_KEY=${tenantResult.apiKey}\n`;
        }
        fsMod.writeFileSync(envPath, envContent);
        console.log(`  Saved TENANT_KEY to ${envPath}`);
      }
    } catch { /* non-critical */ }

    if (deployResult.tables[0]) {
      const t = deployResult.tables[0].table;
      console.log(
        `\nQuery example:\ncurl -X POST ${baseUrl}/v1/tables/${t}/query \\\n  -H "x-tenant-id: ${tenantId}" \\\n  -H "x-tenant-key: ${tenantResult.apiKey}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"page_size":10}'`
      );
    }
  }
}



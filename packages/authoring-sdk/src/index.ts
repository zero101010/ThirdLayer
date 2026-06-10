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

type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

declare const require: any;

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
  modulePath: string;
  tables: Array<{ table: string; result: any }>;
  syncs: string[];
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

  async deployProject(tenantId: string, name: string, modulePath: string): Promise<DeployProjectResponse> {
    if (!tenantId) throw new Error('tenantId is required');
    if (!name) throw new Error('name is required');
    if (!modulePath) throw new Error('modulePath is required');
    return this.postJson<DeployProjectResponse>(
      '/v1/deploy/project',
      { name, modulePath },
      { 'x-tenant-id': tenantId }
    );
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

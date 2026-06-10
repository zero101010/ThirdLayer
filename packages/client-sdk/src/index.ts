// Client SDK - typed Notion-style filters and REST wrapper

// Primitive filter types
export type TextFilter = { equals?: string; contains?: string; starts_with?: string; ends_with?: string };
export type NumberFilter = { equals?: number; gt?: number; lt?: number; gte?: number; lte?: number };
export type CheckboxFilter = { equals?: boolean };
export type SelectFilter = { equals?: string };
export type MultiSelectFilter = { contains?: string };
export type DateFilter = { before?: string; after?: string; equals?: string };

// Property-specific filter
export type PropertyFilter = {
  property: string;
  text?: TextFilter;
  number?: NumberFilter;
  checkbox?: CheckboxFilter;
  select?: SelectFilter;
  multi_select?: MultiSelectFilter;
  datetime?: DateFilter;
  date?: DateFilter;
};

// Compound filters
export type CompoundFilter = { and?: Filter[] } | { or?: Filter[] } | { not?: Filter };

export type Filter = PropertyFilter | CompoundFilter;

export type SortSpec = { property: string; direction: 'ascending' | 'descending' };

export type QueryRequest = {
  table: string;
  filter?: Filter;
  sorts?: SortSpec[];
  page_size?: number;
  start_cursor?: string | null;
};

export type QueryResponse<Row = any> = {
  results: Row[];
  has_more: boolean;
  next_cursor?: string | null;
};

// Use node-fetch when running in Node (ts-node) where global fetch may be missing
declare const require: any;
const _fetch = (globalThis as any).fetch ?? (typeof require !== 'undefined' ? require('node-fetch') : undefined);
if (!_fetch) throw new Error('fetch is not available; provide a global fetch or install node-fetch');

export class Client {
  baseUrl: string;
  tenantId?: string;
  tenantKey?: string;
  constructor(opts: { baseUrl?: string; tenantId?: string; tenantKey?: string } = {}) {
    this.baseUrl = opts.baseUrl ?? 'http://localhost:3000';
    this.tenantId = opts.tenantId;
    this.tenantKey = opts.tenantKey;
  }

  private headers() {
    if (!this.tenantId || !this.tenantKey) throw new Error('tenantId and tenantKey are required');
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    h['x-tenant-id'] = this.tenantId;
    h['x-tenant-key'] = this.tenantKey;
    return h;
  }

  async query<Row = any>(req: QueryRequest): Promise<QueryResponse<Row>> {
    const res = await _fetch(`${this.baseUrl}/v1/tables/${encodeURIComponent(req.table)}/query`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(req),
    });
    if (!res.ok) throw new Error(`query failed: ${res.status}`);
    return res.json();
  }

  async getRow<Row = any>({ table, key }: { table: string; key: string }): Promise<Row | null> {
    const res = await _fetch(`${this.baseUrl}/v1/tables/${encodeURIComponent(table)}/rows/${encodeURIComponent(key)}`, {
      method: 'GET',
      headers: this.headers(),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`getRow failed: ${res.status}`);
    return res.json();
  }

  async createRow({ table, key, values }: { table: string; key: string; values: Record<string, any> }) {
    const res = await _fetch(`${this.baseUrl}/v1/tables/${encodeURIComponent(table)}/rows`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ key, values }),
    });
    if (!res.ok) throw new Error(`createRow failed: ${res.status}`);
    return res.json();
  }

  async updateRow({ table, key, values }: { table: string; key: string; values: Record<string, any> }) {
    const res = await _fetch(`${this.baseUrl}/v1/tables/${encodeURIComponent(table)}/rows/${encodeURIComponent(key)}`, {
      method: 'PATCH',
      headers: this.headers(),
      body: JSON.stringify({ values }),
    });
    if (!res.ok) throw new Error(`updateRow failed: ${res.status}`);
    return res.json();
  }

  async replaceRow({ table, key, values }: { table: string; key: string; values: Record<string, any> }) {
    const res = await _fetch(`${this.baseUrl}/v1/tables/${encodeURIComponent(table)}/rows/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify({ values }),
    });
    if (!res.ok) throw new Error(`replaceRow failed: ${res.status}`);
    return res.json();
  }

  async deleteRow({ table, key }: { table: string; key: string }) {
    const res = await _fetch(`${this.baseUrl}/v1/tables/${encodeURIComponent(table)}/rows/${encodeURIComponent(key)}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`deleteRow failed: ${res.status}`);
    return true;
  }
}

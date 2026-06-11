import { pool, getTableSchema } from './pg';

type FieldType =
  | { kind: 'text' }
  | { kind: 'number' }
  | { kind: 'boolean' }
  | { kind: 'datetime' }
  | { kind: 'select'; options: string[] }
  | { kind: 'multiSelect' };

type SchemaSpec = Record<string, FieldType>;

export class SchemaValidationError extends Error {
  details: string[];
  constructor(message: string, details: string[]) {
    super(message);
    this.name = 'SchemaValidationError';
    this.details = details;
  }
}

export async function upsertRow(tenant: string, table: string, key: string, values: Record<string, any>) {
  await validateIncomingValues(tenant, table, values);
  // merge existing data with new values
  const res = await pool.query('SELECT data FROM rows WHERE tenant_id=$1 AND table_name=$2 AND key=$3', [tenant, table, key]);
  const existing = res.rows[0] ? res.rows[0].data : {};
  const merged = { ...existing, ...values };
  await pool.query(
    `INSERT INTO rows(tenant_id, table_name, key, data, updated_at) VALUES($1, $2, $3, $4, now())
     ON CONFLICT (tenant_id, table_name, key) DO UPDATE SET data = $4, updated_at = now()`,
    [tenant, table, key, merged]
  );
}

export async function replaceRow(tenant: string, table: string, key: string, values: Record<string, any>) {
  await validateIncomingValues(tenant, table, values);
  await pool.query(
    `INSERT INTO rows(tenant_id, table_name, key, data, updated_at) VALUES($1, $2, $3, $4, now())
     ON CONFLICT (tenant_id, table_name, key) DO UPDATE SET data = $4, updated_at = now()`,
    [tenant, table, key, values]
  );
}

export async function deleteRow(tenant: string, table: string, key: string) {
  await pool.query('DELETE FROM rows WHERE tenant_id=$1 AND table_name=$2 AND key=$3', [tenant, table, key]);
}

export async function deleteRowsNotInKeys(tenant: string, table: string, keepKeys: string[]) {
  if (keepKeys.length === 0) {
    await pool.query('DELETE FROM rows WHERE tenant_id=$1 AND table_name=$2', [tenant, table]);
    return;
  }
  await pool.query('DELETE FROM rows WHERE tenant_id=$1 AND table_name=$2 AND NOT (key = ANY($3::text[]))', [tenant, table, keepKeys]);
}

export async function getRow(tenant: string, table: string, key: string) {
  const res = await pool.query('SELECT data FROM rows WHERE tenant_id=$1 AND table_name=$2 AND key=$3', [tenant, table, key]);
  if (!res.rows[0]) return null;
  const raw = res.rows[0].data;
  const schema = (await getTableSchema(tenant, table)) as SchemaSpec | undefined;
  if (schema) {
    const schemaKeys = new Set(Object.keys(schema));
    const values = Object.fromEntries(Object.entries(raw).filter(([k]) => schemaKeys.has(k)));
    return { key, values };
  }
  return { key, values: raw };
}

type QueryFilter =
  | {
      and?: QueryFilter[];
      or?: QueryFilter[];
      not?: QueryFilter;
      property?: string;
      text?: { equals?: string; contains?: string };
      select?: { equals?: string };
      number?: { equals?: number; gt?: number; gte?: number; lt?: number; lte?: number };
      checkbox?: { equals?: boolean };
      datetime?: { equals?: string; before?: string; after?: string };
      date?: { equals?: string; before?: string; after?: string };
      multi_select?: { contains?: string };
    }
  | undefined;

type QuerySort = { property: string; direction?: 'ascending' | 'descending' };

export async function queryRows(
  tenant: string,
  table: string,
  opts: { filter?: QueryFilter; sorts?: QuerySort[]; page_size?: number; start_cursor?: string | null } = {}
) {
  const size = Math.max(1, Math.min(opts.page_size ?? 25, 200));
  const schema = (await getTableSchema(tenant, table)) as SchemaSpec | undefined;
  const schemaKeys = schema ? new Set(Object.keys(schema)) : null;

  const res = await pool.query('SELECT key, data FROM rows WHERE tenant_id=$1 AND table_name=$2', [tenant, table]);
  let rows = res.rows.map((r: any) => {
    const raw = r.data as Record<string, any>;
    // Only return fields declared in the current schema
    const values = schemaKeys
      ? Object.fromEntries(Object.entries(raw).filter(([k]) => schemaKeys.has(k)))
      : raw;
    return { key: r.key as string, values };
  });

  if (opts.filter) rows = rows.filter((r) => matchesFilter(r.values, opts.filter));

  const sorts = opts.sorts && opts.sorts.length > 0 ? opts.sorts : [{ property: 'key', direction: 'ascending' as const }];
  rows.sort((a, b) => compareRows(a, b, sorts));

  let offset = 0;
  if (opts.start_cursor) {
    const decodedOffset = decodeCursorOffset(opts.start_cursor);
    if (decodedOffset !== null) {
      offset = decodedOffset;
    } else {
      // Backward-compatible fallback: treat cursor as last key.
      const idx = rows.findIndex((r) => r.key === opts.start_cursor);
      offset = idx >= 0 ? idx + 1 : 0;
    }
  }

  const page = rows.slice(offset, offset + size);
  const nextOffset = offset + page.length;
  const hasMore = nextOffset < rows.length;
  const nextCursor = hasMore ? encodeCursorOffset(nextOffset) : null;
  return { results: page, has_more: hasMore, next_cursor: nextCursor };
}

export async function listTables(tenant?: string) {
  if (tenant) {
    const res = await pool.query('SELECT table_name FROM table_schemas WHERE tenant_id=$1', [tenant]);
    return res.rows.map((r: any) => r.table_name);
  }
  const res = await pool.query('SELECT tenant_id, table_name FROM table_schemas');
  return res.rows.map((r: any) => ({ tenant: r.tenant_id, table: r.table_name }));
}

function compareRows(
  a: { key: string; values: Record<string, any> },
  b: { key: string; values: Record<string, any> },
  sorts: QuerySort[]
) {
  for (const s of sorts) {
    const direction = s.direction === 'descending' ? -1 : 1;
    const av = s.property === 'key' ? a.key : a.values?.[s.property];
    const bv = s.property === 'key' ? b.key : b.values?.[s.property];
    const c = comparePrimitive(av, bv);
    if (c !== 0) return c * direction;
  }
  return comparePrimitive(a.key, b.key);
}

function comparePrimitive(a: any, b: any) {
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return String(a).localeCompare(String(b));
}

function matchesFilter(values: Record<string, any>, filter: QueryFilter): boolean {
  if (!filter) return true;
  if (filter.and && filter.and.length > 0) return filter.and.every((f) => matchesFilter(values, f));
  if (filter.or && filter.or.length > 0) return filter.or.some((f) => matchesFilter(values, f));
  if (filter.not) return !matchesFilter(values, filter.not);
  if (!filter.property) return true;

  const value = values?.[filter.property];
  if (filter.text) {
    if (filter.text.equals !== undefined) return String(value ?? '') === filter.text.equals;
    if (filter.text.contains !== undefined) return String(value ?? '').includes(filter.text.contains);
  }
  if (filter.select) {
    if (filter.select.equals !== undefined) return String(value ?? '') === filter.select.equals;
  }
  if (filter.number) {
    const n = Number(value);
    if (Number.isNaN(n)) return false;
    if (filter.number.equals !== undefined && n !== filter.number.equals) return false;
    if (filter.number.gt !== undefined && !(n > filter.number.gt)) return false;
    if (filter.number.gte !== undefined && !(n >= filter.number.gte)) return false;
    if (filter.number.lt !== undefined && !(n < filter.number.lt)) return false;
    if (filter.number.lte !== undefined && !(n <= filter.number.lte)) return false;
    return true;
  }
  if (filter.checkbox) {
    if (filter.checkbox.equals !== undefined) return Boolean(value) === filter.checkbox.equals;
  }
  const dateFilter = filter.datetime ?? filter.date;
  if (dateFilter) {
    const dt = value ? new Date(value).getTime() : NaN;
    if (Number.isNaN(dt)) return false;
    if (dateFilter.equals !== undefined && dt !== new Date(dateFilter.equals).getTime()) return false;
    if (dateFilter.before !== undefined && !(dt < new Date(dateFilter.before).getTime())) return false;
    if (dateFilter.after !== undefined && !(dt > new Date(dateFilter.after).getTime())) return false;
    return true;
  }
  if (filter.multi_select) {
    const arr = Array.isArray(value) ? value.map(String) : [];
    if (filter.multi_select.contains !== undefined) return arr.includes(filter.multi_select.contains);
  }
  return false;
}

function encodeCursorOffset(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64');
}

function decodeCursorOffset(cursor: string): number | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
    if (typeof parsed?.offset === 'number' && Number.isInteger(parsed.offset) && parsed.offset >= 0) {
      return parsed.offset;
    }
    return null;
  } catch {
    return null;
  }
}

async function validateIncomingValues(tenant: string, table: string, values: Record<string, any>) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new SchemaValidationError('values must be an object', ['values must be a JSON object']);
  }
  const schema = (await getTableSchema(tenant, table)) as SchemaSpec | undefined;
  if (!schema) {
    throw new SchemaValidationError(`table "${table}" is not deployed for tenant "${tenant}"`, ['deploy table schema before writing rows']);
  }

  const errors: string[] = [];
  for (const [property, value] of Object.entries(values)) {
    const field = schema[property];
    if (!field) {
      errors.push(`property "${property}" is not declared in schema`);
      continue;
    }
    const err = validateFieldValue(property, value, field);
    if (err) errors.push(err);
  }

  if (errors.length > 0) {
    throw new SchemaValidationError('schema validation failed', errors);
  }
}

function validateFieldValue(property: string, value: any, field: FieldType): string | null {
  switch (field.kind) {
    case 'text':
      return typeof value === 'string' ? null : `property "${property}" must be text`;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : `property "${property}" must be a finite number`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `property "${property}" must be boolean`;
    case 'datetime':
      return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? null : `property "${property}" must be an ISO datetime string`;
    case 'select':
      if (typeof value !== 'string') return `property "${property}" must be one of: ${field.options.join(', ')}`;
      return field.options.includes(value) ? null : `property "${property}" must be one of: ${field.options.join(', ')}`;
    case 'multiSelect':
      return Array.isArray(value) && value.every((v) => typeof v === 'string') ? null : `property "${property}" must be an array of strings`;
    default:
      return `property "${property}" has unsupported field type`;
  }
}

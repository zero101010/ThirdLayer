import { upsertRow, deleteRow, deleteRowsNotInKeys } from './db';
import { getDatasourceConfig, getSyncState, setSyncState } from './pg';

type Change = { type: 'upsert' | 'delete'; key: string; values?: Record<string, any> };

type SyncDefinition = {
  name: string;
  table: string;
  mode: 'replace' | 'incremental';
  datasource?: string;
  tenant?: string;
  schedule?: string; // e.g. '5m'
  runOnStart?: boolean;
  execute: (
    state?: any,
    context?: { tenant: string; datasource?: Record<string, any> }
  ) => Promise<{ changes: Change[]; hasMore: boolean; nextState?: any }>;
};

type RegisteredSync = SyncDefinition & { timer?: NodeJS.Timeout };

const registeredSyncs = new Map<string, RegisteredSync>();

export function registerSync(def: SyncDefinition) {
  const id = syncId(def.tenant || 'default', def.name);
  const existing = registeredSyncs.get(id);
  if (existing?.timer) clearInterval(existing.timer);

  const stored: RegisteredSync = { ...def };
  registeredSyncs.set(id, stored);

  if (def.schedule) {
    // Scheduled syncs are automatic.
    if (def.runOnStart !== false) {
      runToCompletion(def).catch((e) => console.error('sync run failed:', e));
    }
    const ms = parseScheduleToMs(def.schedule);
    stored.timer = setInterval(() => runToCompletion(def).catch((e) => console.error('sync run failed:', e)), ms);
    return;
  }

  // Unscheduled syncs are manual by default.
  if (def.runOnStart) runToCompletion(def).catch((e) => console.error('sync run failed:', e));
}

export function unregisterSync(tenant: string, name: string) {
  const id = syncId(tenant, name);
  const existing = registeredSyncs.get(id);
  if (!existing) return false;
  if (existing.timer) clearInterval(existing.timer);
  registeredSyncs.delete(id);
  return true;
}

export function listRegisteredSyncs() {
  return Array.from(registeredSyncs.values()).map((s) => ({
    name: s.name,
    tenant: s.tenant || 'default',
    table: s.table,
    mode: s.mode,
    schedule: s.schedule ?? null,
  }));
}

export async function runRegisteredSync(tenant: string, name: string) {
  const sync = registeredSyncs.get(syncId(tenant, name));
  if (!sync) return { ran: false, reason: 'not_found' };
  await runToCompletion(sync);
  return { ran: true };
}

async function runToCompletion(def: SyncDefinition) {
  const tenant = def.tenant || 'default';
  const datasource = def.datasource ? await getDatasourceConfig(tenant, def.datasource) : undefined;
  const initialState = await getSyncState(tenant, def.name);
  let state = initialState;
  let loop = 0;
  let res: { changes: Change[]; hasMore: boolean; nextState?: any } | null = null;
  const deduped = new Map<string, Change>();

  do {
    res = await def.execute(state, { tenant, datasource });
    for (const c of res.changes || []) deduped.set(c.key, c);
    state = res.nextState;
    await setSyncState(tenant, def.name, state ?? null);
    loop += 1;
    if (loop > 1000) throw new Error('sync seems to be stuck in infinite pagination');
  } while (resHasMore(res));

  const keepKeys = new Set<string>();
  for (const c of deduped.values()) {
    if (c.type === 'upsert') {
      await upsertRow(tenant, def.table, c.key, c.values || {});
      keepKeys.add(c.key);
    } else if (c.type === 'delete') {
      await deleteRow(tenant, def.table, c.key);
    }
  }

  if (def.mode === 'replace') {
    await deleteRowsNotInKeys(tenant, def.table, Array.from(keepKeys));
  }
}

function resHasMore(r: any) {
  return !!r && r.hasMore !== undefined ? r.hasMore : false;
}

function parseScheduleToMs(s: string): number {
  if (s.endsWith('m')) return parseInt(s.slice(0, -1), 10) * 60 * 1000;
  if (s.endsWith('s')) return parseInt(s.slice(0, -1), 10) * 1000;
  return parseInt(s, 10) * 1000;
}

function syncId(tenant: string, name: string) {
  return `${tenant}::${name}`;
}

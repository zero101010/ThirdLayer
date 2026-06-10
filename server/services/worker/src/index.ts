import {
  initDb,
  listDeployedProjects,
  migrateTableSchema,
  listPendingSyncRunRequests,
  markSyncRunRequestStatus,
} from '../../../src/pg';
import { registerSync, runRegisteredSync, unregisterSync } from '../../../src/syncRunner';

type LoadedProject = { fingerprint: string; syncNames: string[] };

const loadedProjects = new Map<string, LoadedProject>();

async function processManualRunQueue() {
  const requests = await listPendingSyncRunRequests(20);
  for (const r of requests) {
    const id = Number(r.id);
    try {
      await markSyncRunRequestStatus(id, 'running');
      const result = await runRegisteredSync(String(r.tenant_id), String(r.sync_name));
      if (!result.ran) {
        await markSyncRunRequestStatus(id, 'failed', String(result.reason || 'not_found'));
      } else {
        await markSyncRunRequestStatus(id, 'done');
      }
    } catch (e: any) {
      await markSyncRunRequestStatus(id, 'failed', String(e?.message || e));
    }
  }
}

async function loadDeployedProjects() {
  const deployed = await listDeployedProjects();
  const seenProjectKeys = new Set<string>();
  for (const p of deployed) {
    try {
      const projectKey = `${p.tenant_id}::${p.name}`;
      seenProjectKeys.add(projectKey);
      const fingerprint = `${p.module_path}:${new Date(p.updated_at).toISOString()}`;
      const existing = loadedProjects.get(projectKey);
      if (existing?.fingerprint === fingerprint) continue;

      if (existing) {
        for (const syncName of existing.syncNames) {
          unregisterSync(String(p.tenant_id), syncName);
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sdk = require('../../../../packages/authoring-sdk/src');
      if (typeof sdk?.resetProjectRegistry === 'function') sdk.resetProjectRegistry();
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete require.cache[require.resolve(p.module_path)];
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const loaded = require(p.module_path);
      const project = loaded?.project;
      if (!project || !Array.isArray(project.tables) || !Array.isArray(project.syncs)) {
        console.log(`worker: invalid project module at ${p.module_path}`);
        continue;
      }

      for (const t of project.tables || []) {
        await migrateTableSchema(p.tenant_id, t.name, t.primaryKey, t.schema);
      }

      for (const s of project.syncs || []) {
        registerSync({
          name: s.name,
          table: s.table.name,
          mode: s.mode,
          datasource: s.datasource,
          schedule: s.schedule,
          execute: s.execute,
          tenant: p.tenant_id,
        });
        console.log(`worker: registered sync ${p.tenant_id}/${s.name}`);
      }

      loadedProjects.set(projectKey, {
        fingerprint,
        syncNames: (project.syncs || []).map((s: any) => String(s.name)),
      });
    } catch (e) {
      console.error(`worker: failed loading project ${p?.tenant_id}/${p?.name}`, e);
    }
  }

  for (const [projectKey, loaded] of loadedProjects) {
    if (seenProjectKeys.has(projectKey)) continue;
    const split = projectKey.indexOf('::');
    const tenant = split >= 0 ? projectKey.slice(0, split) : 'default';
    for (const syncName of loaded.syncNames) {
      unregisterSync(tenant, syncName);
    }
    loadedProjects.delete(projectKey);
  }
}

async function start() {
  await initDb();
  console.log('Worker: DB initialized');

  await loadDeployedProjects();
  setInterval(() => {
    loadDeployedProjects().catch((e) => console.error('worker refresh failed', e));
  }, 30_000);
  setInterval(() => {
    processManualRunQueue().catch((e) => console.error('worker manual sync queue failed', e));
  }, 5_000);

  console.log('Worker started');
}

if (require.main === module) {
  start().catch((e) => {
    console.error('worker failed', e);
    process.exit(1);
  });
}

export default start;

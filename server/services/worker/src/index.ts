import path from 'path';
import {
  initDb,
  listAllSyncs,
  getSyncState,
  setSyncState,
  getDeployedProject,
  getDatasourceConfig,
  listPendingSyncRunRequests,
  markSyncRunRequestStatus,
  getSyncMetadata,
  getSyncLastRunAt,
  migrateTableSchema,
  registerSync,
  upsertDeployedProject,
} from '../../../src/pg';
import { upsertRow, deleteRow, deleteRowsNotInKeys } from '../../../src/db';

const os = require('os');
const fs = require('fs');

// Cache of loaded projects to avoid reloading
const projectCache = new Map<string, any>();
const syncCache = new Map<string, any>();
const sourceHashCache = new Map<string, string>();

// Resolve the absolute path to the SDK so we can rewrite imports in temp files
const SDK_ABS_PATH = path.resolve(__dirname, '../../../../packages/authoring-sdk/src');

/**
 * Rewrite imports in project source code so they resolve from the temp directory.
 * - Any relative import of the SDK → absolute path
 * - Strip dotenv import/config (worker already has env vars)
 */
function rewriteImports(sourceCode: string): string {
  let code = sourceCode;
  // Replace any relative SDK import path with absolute
  code = code.replace(
    /from\s+['"]([^'"]*authoring-sdk\/src[^'"]*)['"]/g,
    `from '${SDK_ABS_PATH}'`
  );
  // Also handle require() style
  code = code.replace(
    /require\s*\(\s*['"]([^'"]*authoring-sdk\/src[^'"]*)['"]\s*\)/g,
    `require('${SDK_ABS_PATH}')`
  );
  // Strip dotenv import and config call (not needed in worker)
  code = code.replace(/^import\s+dotenv\s+from\s+['"]dotenv['"];?\s*$/gm, '');
  code = code.replace(/^dotenv\.config\(\);?\s*$/gm, '');
  return code;
}

/**
 * Execute source code from database and get the project object
 */
function executeProjectSource(tenantId: string, projectName: string, sourceCode: string): any {
  const cacheKey = `${tenantId}::${projectName}`;

  // Return cached version only if source code hasn't changed
  if (projectCache.has(cacheKey) && sourceHashCache.get(cacheKey) === sourceCode) {
    return projectCache.get(cacheKey);
  }

  const tmpDir = path.join(os.tmpdir(), 'thirdlayer-projects');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `${tenantId}-${projectName}-${Date.now()}.ts`);

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sdk = require('../../../../packages/authoring-sdk/src');
    if (typeof sdk?.resetProjectRegistry === 'function') sdk.resetProjectRegistry();

    // Rewrite imports to absolute paths and write to temp file
    const rewritten = rewriteImports(sourceCode);
    fs.writeFileSync(tmpFile, rewritten);

    // Load with ts-node (registered globally)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const loaded = require(tmpFile);
    const project = loaded?.project;

    // Clear Node's require cache for this temp file so future reloads get fresh code
    delete require.cache[require.resolve(tmpFile)];

    if (project) {
      projectCache.set(cacheKey, project);
      sourceHashCache.set(cacheKey, sourceCode);
    }

    // Clean up async
    setImmediate(() => {
      try {
        fs.unlinkSync(tmpFile);
      } catch (e) {
        // Ignore
      }
    });

    return project;
  } catch (e) {
    console.error(`Worker: Failed to execute project source for ${tenantId}/${projectName}:`, e);
    throw e;
  }
}

/**
 * Auto-migrate table schemas and sync metadata from a loaded project.
 * This ensures the DB schema always matches the source code,
 * so syncs never fail due to stale schema.
 */
async function autoMigrateProject(tenantId: string, projectName: string, project: any, sourceCode: string): Promise<void> {
  // Migrate table schemas (destructive: auto-apply additions and removals)
  for (const table of project.tables || []) {
    try {
      const result = await migrateTableSchema(tenantId, table.name, table.primaryKey, table.schema, { destructive: true });
      if (result.applied) {
        console.log(`Worker: Auto-migrated schema ${tenantId}/${table.name}: ${result.reason}`);
      }
    } catch (e) {
      console.error(`Worker: Failed to auto-migrate schema ${tenantId}/${table.name}:`, e);
    }
  }

  // Re-register syncs so metadata stays current
  for (const sync of project.syncs || []) {
    try {
      await registerSync(tenantId, projectName, sync.name, {
        table: sync.table.name,
        mode: sync.mode,
        datasource: sync.datasource,
        schedule: sync.schedule,
      });
    } catch (e) {
      console.error(`Worker: Failed to register sync ${tenantId}/${sync.name}:`, e);
    }
  }

  // Update stored source code so it matches what we just migrated
  try {
    await upsertDeployedProject(tenantId, projectName, sourceCode);
  } catch (e) {
    console.error(`Worker: Failed to update stored source for ${tenantId}/${projectName}:`, e);
  }
}

/**
 * Get a sync definition from cache, loading the project if needed
 */
async function getSyncDef(tenantId: string, syncName: string, projectName: string): Promise<any> {
  const cacheKey = `${tenantId}::${syncName}`;

  if (syncCache.has(cacheKey)) {
    return syncCache.get(cacheKey);
  }

  // Try loading the project
  const deployedProject = await getDeployedProject(tenantId, projectName);
  if (!deployedProject?.source_code) return undefined;

  const project = executeProjectSource(tenantId, projectName, deployedProject.source_code);
  if (!project) return undefined;

  // Cache all syncs from this project
  for (const sync of project.syncs || []) {
    syncCache.set(`${tenantId}::${sync.name}`, sync);
  }

  return syncCache.get(cacheKey);
}

/**
 * Execute a sync: run pagination loop, apply changes, persist state
 */
async function executeSyncLoop(
  tenantId: string,
  syncName: string,
  syncMetadata: any,
  syncDef: any
): Promise<void> {
  if (!syncDef || typeof syncDef.execute !== 'function') {
    throw new Error(`Sync ${syncName} has no execute function`);
  }

  const table = syncMetadata.table_name;
  const mode = syncMetadata.mode;
  const datasource = syncMetadata.datasource;

  // Auto-migrate schema before writing data — ensures DB matches the code
  const tableDef = syncDef.table;
  if (tableDef?.schema) {
    const migration = await migrateTableSchema(tenantId, tableDef.name, tableDef.primaryKey, tableDef.schema, { destructive: true });
    if (migration.applied) {
      console.log(`Worker: Auto-migrated schema ${tenantId}/${tableDef.name} before sync: ${migration.reason}`);
    }
  }

  let state = await getSyncState(tenantId, syncName);
  let loop = 0;
  let allChanges = new Map<string, any>();

  // Get datasource config if specified
  const datasourceConfig = datasource ? await getDatasourceConfig(tenantId, datasource) : undefined;

  // Pagination loop
  while (true) {
    let result;
    try {
      result = await syncDef.execute(state, { tenant: tenantId, datasource: datasourceConfig });
    } catch (e) {
      console.error(`Sync ${tenantId}/${syncName} execute failed:`, e);
      throw e;
    }

    // Accumulate changes (deduped by key)
    if (Array.isArray(result?.changes)) {
      for (const change of result.changes) {
        allChanges.set(change.key, change);
      }
    }

    // Update state for next iteration
    state = result?.nextState;
    await setSyncState(tenantId, syncName, state ?? null);

    loop++;
    if (loop > 1000) {
      throw new Error(`Sync ${syncName} stuck in infinite pagination loop`);
    }

    // Check if more data to fetch
    if (!result?.hasMore) {
      break;
    }
  }

  // Apply all changes to database
  const keepKeys = new Set<string>();
  for (const [key, change] of allChanges) {
    if (change.type === 'upsert') {
      await upsertRow(tenantId, table, key, change.values || {});
      keepKeys.add(key);
    } else if (change.type === 'delete') {
      await deleteRow(tenantId, table, key);
    }
  }

  // For replace mode, delete rows not in this sync
  if (mode === 'replace') {
    await deleteRowsNotInKeys(tenantId, table, Array.from(keepKeys));
  }

  console.log(`Worker: Sync ${tenantId}/${syncName} applied ${allChanges.size} changes`);
}

/**
 * Load all deployed projects from database and cache their syncs
 */
async function loadDeployedProjects(): Promise<void> {
  const allSyncs = await listAllSyncs();
  const projectsByKey = new Map<string, { tenantId: string; name: string }>();

  for (const syncMeta of allSyncs) {
    const projectKey = `${syncMeta.tenant_id}::${syncMeta.project_name}`;
    if (!projectsByKey.has(projectKey)) {
      projectsByKey.set(projectKey, { tenantId: syncMeta.tenant_id, name: syncMeta.project_name });
    }
  }

  for (const [projectKey, projectInfo] of projectsByKey) {
    try {
      const deployedProject = await getDeployedProject(projectInfo.tenantId, projectInfo.name);
      if (!deployedProject || !deployedProject.source_code) {
        continue;
      }

      const cacheKey = `${projectInfo.tenantId}::${projectInfo.name}`;
      const sourceChanged = sourceHashCache.get(cacheKey) !== deployedProject.source_code;

      const project = executeProjectSource(projectInfo.tenantId, projectInfo.name, deployedProject.source_code);
      if (!project) continue;

      // Auto-migrate schemas when source code has changed
      if (sourceChanged) {
        await autoMigrateProject(projectInfo.tenantId, projectInfo.name, project, deployedProject.source_code);
      }

      for (const sync of project.syncs || []) {
        const syncCacheKey = `${projectInfo.tenantId}::${sync.name}`;
        syncCache.set(syncCacheKey, sync);
      }

      console.log(`Worker: Loaded project ${projectKey}`);
    } catch (e) {
      console.error(`Worker: Failed to load project ${projectKey}:`, e);
    }
  }
}

/**
 * Process enqueued sync run requests (from enqueueSync API)
 */
async function processSyncRunRequests(): Promise<void> {
  const pending = await listPendingSyncRunRequests(20);

  for (const request of pending) {
    const { id, tenant_id: tenantId, sync_name: syncName } = request;

    try {
      await markSyncRunRequestStatus(id, 'running');

      const syncMeta = await getSyncMetadata(tenantId, syncName);
      if (!syncMeta) {
        throw new Error(`Sync metadata not found for ${tenantId}/${syncName}`);
      }

      const syncDef = await getSyncDef(tenantId, syncName, syncMeta.project_name);
      if (!syncDef) {
        throw new Error(`Sync definition not found for ${tenantId}/${syncName}`);
      }

      console.log(`Worker: Running enqueued sync ${tenantId}/${syncName} (request ${id})`);
      await executeSyncLoop(tenantId, syncName, syncMeta, syncDef);
      await markSyncRunRequestStatus(id, 'done');
      console.log(`Worker: Completed enqueued sync ${tenantId}/${syncName}`);
    } catch (e: any) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      const details = e?.details ? ` [${e.details.join(', ')}]` : '';
      console.error(`Worker: Failed enqueued sync ${tenantId}/${syncName}:`, errorMsg + details);
      await markSyncRunRequestStatus(id, 'failed', errorMsg + details);
    }
  }
}

/**
 * Parse schedule string (e.g. "1m", "30s", "5m") to milliseconds
 */
function parseScheduleToMs(schedule: string): number {
  const match = schedule.match(/^(\d+)(s|m|h)$/);
  if (!match) return 0;
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    default: return 0;
  }
}

/**
 * Run scheduled syncs that are due
 */
async function processScheduledSyncs(): Promise<void> {
  const allSyncs = await listAllSyncs();
  const now = Date.now();

  for (const syncMeta of allSyncs) {
    if (!syncMeta.schedule) continue;

    const intervalMs = parseScheduleToMs(syncMeta.schedule);
    if (intervalMs <= 0) continue;

    const lastRun = await getSyncLastRunAt(syncMeta.tenant_id, syncMeta.sync_name);
    const elapsed = lastRun ? now - lastRun.getTime() : Infinity;

    if (elapsed < intervalMs) continue;

    try {
      const syncDef = await getSyncDef(syncMeta.tenant_id, syncMeta.sync_name, syncMeta.project_name);
      if (!syncDef) {
        console.warn(`Worker: Sync definition not found for scheduled sync ${syncMeta.tenant_id}/${syncMeta.sync_name}`);
        continue;
      }

      console.log(`Worker: Running scheduled sync ${syncMeta.tenant_id}/${syncMeta.sync_name}`);
      await executeSyncLoop(syncMeta.tenant_id, syncMeta.sync_name, syncMeta, syncDef);
      console.log(`Worker: Completed scheduled sync ${syncMeta.tenant_id}/${syncMeta.sync_name}`);
    } catch (e: any) {
      const details = e?.details ? ` [${e.details.join(', ')}]` : '';
      console.error(`Worker: Scheduled sync ${syncMeta.tenant_id}/${syncMeta.sync_name} failed:`, (e instanceof Error ? e.message : e) + details);
    }
  }
}

/**
 * Main worker loop
 */
async function start(): Promise<void> {
  await initDb();
  console.log('Worker: Database initialized');

  // Load projects on startup
  await loadDeployedProjects();

  // Main loop: process enqueued requests + reload projects periodically
  const pollIntervalMs = 5_000; // 5 seconds
  let reloadCounter = 0;

  setInterval(async () => {
    try {
      // Reload projects every ~30 seconds to pick up new deployments
      reloadCounter++;
      if (reloadCounter % 6 === 0) {
        projectCache.clear();
        syncCache.clear();
        sourceHashCache.clear();
        await loadDeployedProjects();
      }

      // Process enqueued sync requests
      await processSyncRunRequests();

      // Run scheduled syncs that are due
      await processScheduledSyncs();
    } catch (e) {
      console.error('Worker: Processing failed:', e);
    }
  }, pollIntervalMs);

  console.log('Worker: Started');
}

// Start if this is the main module
if (require.main === module) {
  start().catch((e) => {
    console.error('Worker: Failed to start:', e);
    process.exit(1);
  });
}

export default start;

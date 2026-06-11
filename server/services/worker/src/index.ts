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
} from '../../../src/pg';
import { upsertRow, deleteRow, deleteRowsNotInKeys } from '../../../src/db';

const os = require('os');
const fs = require('fs');

// Cache of loaded projects to avoid reloading
const projectCache = new Map<string, any>();
const syncCache = new Map<string, any>();

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

  if (projectCache.has(cacheKey)) {
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

    if (project) {
      projectCache.set(cacheKey, project);
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

      const project = executeProjectSource(projectInfo.tenantId, projectInfo.name, deployedProject.source_code);
      if (!project) continue;

      for (const sync of project.syncs || []) {
        const cacheKey = `${projectInfo.tenantId}::${sync.name}`;
        syncCache.set(cacheKey, sync);
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
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      console.error(`Worker: Failed enqueued sync ${tenantId}/${syncName}:`, errorMsg);
      await markSyncRunRequestStatus(id, 'failed', errorMsg);
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
        await loadDeployedProjects();
      }

      // Process enqueued sync requests
      await processSyncRunRequests();
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

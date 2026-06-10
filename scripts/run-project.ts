import path from 'path';
import dotenv from 'dotenv';
import { ThirdLayerAdminApi } from '../packages/authoring-sdk/src';

dotenv.config();

type RawArgs = Record<string, string | boolean>;

function parseArgs(argv: string[]): RawArgs {
  const parsed: RawArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const withoutPrefix = token.slice(2);
    if (!withoutPrefix) continue;
    const eqIndex = withoutPrefix.indexOf('=');
    if (eqIndex >= 0) {
      const key = withoutPrefix.slice(0, eqIndex);
      const value = withoutPrefix.slice(eqIndex + 1);
      parsed[key] = value;
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      parsed[withoutPrefix] = next;
      i += 1;
    } else {
      parsed[withoutPrefix] = true;
    }
  }
  return parsed;
}

function getArg(args: RawArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function usage(): string {
  return `Usage:
  npm run run:project -- --tenant acme --module-path examples/github-sync/project.ts [options]

Options:
  --base-url       API base URL (default: http://localhost:3000 or THIRDLAYER_BASE_URL)
  --admin-key      Admin API key (default: ADMIN_API_KEY from .env)
  --tenant         Tenant ID (default: acme)
  --module-path    Project module path (required)
  --project-name   Registered project name (default: from module filename)
  --provider       Datasource provider (default: github)
  --github-token   Datasource token
  --owner          Datasource owner
  --repo           Datasource repo
  --tenant-key     Existing tenant key (or TENANT_KEY env) for query examples
  --sync-name      Sync name to enqueue (default: first deployed sync)
  --skip-sync      Do not enqueue sync run
  --help           Show this help`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const modulePath = getArg(args, 'module-path') ?? getArg(args, 'module');
  if (!modulePath) {
    throw new Error(`--module-path is required.\n\n${usage()}`);
  }

  const tenant = getArg(args, 'tenant') ?? 'acme';
  const provider = getArg(args, 'provider') ?? 'github';
  const baseUrl = (getArg(args, 'base-url') ?? process.env.THIRDLAYER_BASE_URL ?? 'http://localhost:3000').replace(
    /\/+$/,
    ''
  );
  const adminKey = getArg(args, 'admin-key') ?? process.env.ADMIN_API_KEY;
  if (!adminKey) {
    throw new Error('--admin-key is required (or set ADMIN_API_KEY in .env)');
  }
  const adminApi = new ThirdLayerAdminApi({ baseUrl, adminApiKey: adminKey });

  const projectName =
    getArg(args, 'project-name') ?? (path.basename(modulePath).replace(/\.[^.]+$/, '') || 'project');
  const syncNameArg = getArg(args, 'sync-name');
  const skipSync = !!args['skip-sync'];
  const existingTenantKey = getArg(args, 'tenant-key') ?? process.env.TENANT_KEY;

  const datasourceConfig = {
    token: getArg(args, 'github-token') ?? process.env.GITHUB_TOKEN,
    owner: getArg(args, 'owner') ?? process.env.GITHUB_OWNER,
    repo: getArg(args, 'repo') ?? process.env.GITHUB_REPO,
  };
  const config = Object.fromEntries(
    Object.entries(datasourceConfig).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0)
  );

  console.log(`1/4 Creating tenant "${tenant}"...`);
  const tenantResult = await adminApi.createTenant(tenant);
  const effectiveTenantKey = tenantResult.apiKey ?? existingTenantKey ?? null;
  if (tenantResult.created) {
    console.log(`Tenant created: ${tenantResult.tenantId}`);
  } else {
    console.log(`Tenant already exists: ${tenantResult.tenantId} (kept existing key)`);
  }

  if (Object.keys(config).length > 0) {
    console.log(`2/4 Saving datasource config "${provider}" for tenant "${tenant}"...`);
    await adminApi.setDatasourceConfig(tenant, provider, config);
    console.log('Datasource config saved.');
  } else {
    console.log('2/4 Skipping datasource config (no token/owner/repo provided).');
  }

  console.log(`3/4 Deploying project "${projectName}" from "${modulePath}"...`);
  const deployResult = await adminApi.deployProject(tenant, projectName, modulePath);
  const deployedSyncs = Array.isArray(deployResult.syncs) ? deployResult.syncs : [];
  const deployedTables = Array.isArray(deployResult.tables) ? deployResult.tables.map((t) => t.table) : [];
  console.log(`Project deployed. Tables: ${deployedTables.join(', ') || '(none)'}. Syncs: ${deployedSyncs.join(', ') || '(none)'}.`);

  if (skipSync) {
    console.log('4/4 Skipping sync enqueue (--skip-sync).');
  } else {
    const syncName = syncNameArg ?? deployedSyncs[0];
    if (!syncName) throw new Error('No sync available to enqueue. Pass --sync-name or ensure project defines at least one sync.');
    console.log(`4/4 Enqueuing sync "${syncName}"...`);
    await adminApi.enqueueSync(tenant, syncName);
    console.log('Sync enqueued.');
  }

  console.log('\nDone.');
  console.log(`Tenant ID: ${tenantResult.tenantId}`);
  if (effectiveTenantKey) console.log(`Tenant Key: ${effectiveTenantKey}`);
  if (deployedTables[0] && effectiveTenantKey) {
    console.log('\nExample query:');
    console.log(
      `curl -s -X POST ${baseUrl}/v1/tables/${deployedTables[0]}/query -H "x-tenant-id: ${tenantResult.tenantId}" -H "x-tenant-key: ${effectiveTenantKey}" -H "Content-Type: application/json" -d '{"page_size":10}'`
    );
  } else if (deployedTables[0]) {
    console.log('\nTenant key not returned because tenant already existed. Pass --tenant-key (or TENANT_KEY) to print query example.');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

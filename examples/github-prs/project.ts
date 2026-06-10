import { table, field, sync, project, ThirdLayerAdminApi } from '../../packages/authoring-sdk/src';
import { bumpCursorTimestamp, getGitHubRepo, githubGet, hasNextFromLink } from '../github-api';
import dotenv from 'dotenv';

dotenv.config();

const pullRequests = table('pull_requests', {
  primaryKey: 'id',
  schema: {
    id: field.text(),
    title: field.text(),
    state: field.select(['open', 'closed', 'merged']),
    author: field.text(),
    labels: field.multiSelect(),
    isDraft: field.boolean(),
    updatedAt: field.datetime(),
  },
});

type GitHubPull = {
  id: number;
  title: string;
  state: string;
  updated_at: string;
  user?: { login?: string };
  labels?: Array<{ name?: string }>;
  draft?: boolean;
  merged_at?: string | null;
};

sync('github-prs', {
  table: pullRequests,
  mode: 'incremental',
  datasource: 'github',
  schedule: '5m',
  async execute(state, context) {
    const { owner, repo } = getGitHubRepo('GITHUB_PRS', context);
    const perPage = 50;
    const since = typeof state?.since === 'string' ? state.since : '1970-01-01T00:00:00.000Z';
    const page = typeof state?.page === 'number' && state.page > 0 ? state.page : 1;
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
      repo
    )}/pulls?state=all&sort=updated&direction=desc&per_page=${perPage}&page=${page}`;
    const { data, link } = await githubGet<GitHubPull[]>(url, context);
    const items = Array.isArray(data) ? data : [];

    const updatedSince = new Date(since).getTime();
    const fresh = items.filter((pr) => {
      const updatedAt = new Date(String(pr.updated_at || '')).getTime();
      return !Number.isNaN(updatedAt) && updatedAt > updatedSince;
    });

    const latestUpdatedAt = fresh.reduce((acc, item) => {
      const next = String(item.updated_at || '');
      if (!acc) return next;
      return next > acc ? next : acc;
    }, '');
    const nextSince = latestUpdatedAt ? bumpCursorTimestamp(latestUpdatedAt) : since;
    const hasMore = hasNextFromLink(link) && fresh.length === items.length;

    return {
      changes: fresh.map((pr) => {
        const merged = !!pr.merged_at;
        const stateValue = merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open';
        return {
          type: 'upsert' as const,
          key: String(pr.id),
          values: {
            id: String(pr.id),
            title: String(pr.title ?? ''),
            state: stateValue,
            author: String(pr.user?.login ?? ''),
            labels: Array.isArray(pr.labels) ? pr.labels.map((l) => String(l.name ?? '')).filter((l) => l.length > 0) : [],
            isDraft: !!pr.draft,
            updatedAt: String(pr.updated_at ?? new Date().toISOString()),
          },
        };
      }),
      hasMore,
      nextState: hasMore ? { since, page: page + 1 } : { since: nextSince, page: 1 },
    };
  },
});

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
      parsed[withoutPrefix.slice(0, eqIndex)] = withoutPrefix.slice(eqIndex + 1);
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

function printRunHelp() {
  console.log(`Run this file directly to do tenant + datasource + deploy + sync in one command:

npx ts-node examples/github-prs/project.ts [options]

Options:
  --base-url       API base URL (default: http://localhost:3000 or THIRDLAYER_BASE_URL)
  --admin-key      Admin API key (default: ADMIN_API_KEY from .env)
  --tenant         Tenant ID (default: TENANT_ID or "acme")
  --module-path    Module path to deploy (default: examples/github-prs/project.ts)
  --project-name   Deploy project name (default: github-prs)
  --sync-name      Sync to enqueue (default: github-prs)
  --provider       Datasource provider (default: github)
  --github-token   GitHub token (or GITHUB_TOKEN)
  --owner          GitHub owner (or GITHUB_PRS_OWNER/GITHUB_OWNER)
  --repo           GitHub repo (or GITHUB_PRS_REPO/GITHUB_REPO)
  --skip-sync      Skip sync enqueue
  --help           Show this help`);
}

async function runDirect() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printRunHelp();
    return;
  }

  const baseUrl = (getArg(args, 'base-url') ?? process.env.THIRDLAYER_BASE_URL ?? 'http://localhost:3000').replace(
    /\/+$/,
    ''
  );
  const adminKey = getArg(args, 'admin-key') ?? process.env.ADMIN_API_KEY;
  if (!adminKey) throw new Error('--admin-key is required (or set ADMIN_API_KEY in .env)');
  const adminApi = new ThirdLayerAdminApi({ baseUrl, adminApiKey: adminKey });
  const tenant = getArg(args, 'tenant') ?? process.env.TENANT_ID ?? 'acme';
  const modulePath = getArg(args, 'module-path') ?? 'examples/github-prs/project.ts';
  const projectName = getArg(args, 'project-name') ?? 'github-prs';
  const syncName = getArg(args, 'sync-name') ?? 'github-prs';
  const provider = getArg(args, 'provider') ?? 'github';
  const skipSync = !!args['skip-sync'];

  const datasourceConfig = {
    token: getArg(args, 'github-token') ?? process.env.GITHUB_TOKEN,
    owner: getArg(args, 'owner') ?? process.env.GITHUB_PRS_OWNER ?? process.env.GITHUB_OWNER,
    repo: getArg(args, 'repo') ?? process.env.GITHUB_PRS_REPO ?? process.env.GITHUB_REPO,
  };
  const config = Object.fromEntries(
    Object.entries(datasourceConfig).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0)
  );

  console.log(`1/4 Creating tenant "${tenant}"...`);
  const tenantResult = await adminApi.createTenant(tenant);

  if (Object.keys(config).length > 0) {
    console.log(`2/4 Saving datasource config "${provider}"...`);
    await adminApi.setDatasourceConfig(tenant, provider, config);
  } else {
    console.log('2/4 Skipping datasource config (no token/owner/repo provided).');
  }

  console.log(`3/4 Deploying "${projectName}" from "${modulePath}"...`);
  await adminApi.deployProject(tenant, projectName, modulePath);

  if (skipSync) {
    console.log('4/4 Skipping sync enqueue (--skip-sync).');
  } else {
    console.log(`4/4 Enqueuing sync "${syncName}"...`);
    await adminApi.enqueueSync(tenant, syncName);
  }

  console.log('\nDone.');
  console.log(`Tenant ID: ${tenantResult.tenantId}`);
  console.log(`Tenant Key: ${tenantResult.apiKey}`);
  console.log(
    `curl -s -X POST ${baseUrl}/v1/tables/pull_requests/query -H "x-tenant-id: ${tenantResult.tenantId}" -H "x-tenant-key: ${tenantResult.apiKey}" -H "Content-Type: application/json" -d '{"page_size":10}'`
  );
}

if (typeof require !== 'undefined' && require.main === module) {
  runDirect().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { project };

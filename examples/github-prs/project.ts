import { table, field, sync, deploy, project, getGitHubRepo, githubGet, hasNextFromLink, bumpCursorTimestamp } from '../../packages/authoring-sdk/src';
export { project };

// ============================================================================
// TABLE DEFINITIONS
// ============================================================================

const pullRequests = table('pull_requests', {
  primaryKey: 'id',
  schema: {
    id: field.text(),
    title: field.text(),
    author: field.text(),
    state: field.select(['open', 'closed', 'merged']),
    labels: field.multiSelect(),
    isDraft: field.boolean(),
    updatedAt: field.datetime(),
  },
});

// ============================================================================
// SYNC DEFINITIONS
// ============================================================================

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
  mode: 'replace',
  datasource: 'github',
  schedule: '1m',
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

// ============================================================================
// DEPLOY - just call deploy(), SDK handles everything from .env
// ============================================================================

if (typeof require !== 'undefined' && require.main === module) {
  deploy({ projectName: 'github-prs-zero', destructive: true }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

import { table, field, sync, project } from '../../packages/authoring-sdk/src';
import { getGitHubRepo, githubGet, hasNextFromLink } from '../github-api';

const issues = table('issues', {
  primaryKey: 'id',
  schema: {
    id: field.text(),
    title: field.text(),
    state: field.select(['open', 'closed']),
    comments: field.number(),
    createdAt: field.datetime(),
    isUrgent: field.boolean(),
  },
});

sync('example-issues', {
  table: issues,
  mode: 'replace',
  datasource: 'github',
  schedule: '15m',
  async execute(state, context) {
    const { owner, repo } = getGitHubRepo('GITHUB_ISSUES', context);
    const page = typeof state?.page === 'number' && state.page > 0 ? state.page : 1;
    const perPage = 50;
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
      repo
    )}/issues?state=all&sort=updated&direction=desc&per_page=${perPage}&page=${page}`;
    const { data, link } = await githubGet<any[]>(url, context);
    const issuesOnly = (data || []).filter((i) => !i.pull_request);

    return {
      changes: issuesOnly.map((i) => ({
        type: 'upsert' as const,
        key: String(i.id),
        values: {
          id: String(i.id),
          title: String(i.title ?? ''),
          state: i.state === 'closed' ? 'closed' : 'open',
          comments: Number(i.comments ?? 0),
          createdAt: String(i.created_at ?? new Date().toISOString()),
          isUrgent: Array.isArray(i.labels)
            ? i.labels.some((l: any) => {
                const name = String(l?.name ?? '').toLowerCase();
                return name.includes('urgent') || name.includes('p0') || name.includes('high-priority');
              })
            : false,
        },
      })),
      hasMore: hasNextFromLink(link),
      nextState: hasNextFromLink(link) ? { page: page + 1 } : undefined,
    };
  },
});

export { project };

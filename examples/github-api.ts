type GitHubRepo = { owner: string; repo: string };
type GitHubSyncContext = { datasource?: Record<string, any> };

declare const require: any;
const _fetch = (globalThis as any).fetch ?? (typeof require !== 'undefined' ? require('node-fetch') : undefined);
if (!_fetch) throw new Error('fetch is not available; provide a global fetch or install node-fetch');

export function getGitHubRepo(prefix: string, context?: GitHubSyncContext): GitHubRepo {
  const owner =
    context?.datasource?.owner || process.env[`${prefix}_OWNER`] || process.env.GITHUB_OWNER || 'octocat';
  const repo =
    context?.datasource?.repo || process.env[`${prefix}_REPO`] || process.env.GITHUB_REPO || 'Hello-World';
  return { owner, repo };
}

export class GitHubApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, message: string, body: string) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
    this.body = body;
  }
}

export async function githubGet<T>(url: string, context?: GitHubSyncContext): Promise<{ data: T; link: string | null }> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'thirdlayer-takehome',
  };
  const token = context?.datasource?.token || process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await _fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text();
    const remaining = res.headers.get('x-ratelimit-remaining');
    const resetRaw = res.headers.get('x-ratelimit-reset');
    const resetAt =
      resetRaw && /^\d+$/.test(resetRaw) ? new Date(Number(resetRaw) * 1000).toISOString() : undefined;

    if (res.status === 403 && remaining === '0') {
      throw new GitHubApiError(
        403,
        `GitHub API rate limit exceeded. Set GITHUB_TOKEN for authenticated requests.${
          resetAt ? ` Limit resets at ${resetAt}.` : ''
        }`,
        body
      );
    }

    if (res.status === 422 && body.includes('Pagination with the page parameter is not supported')) {
      throw new GitHubApiError(
        422,
        'This repository is too large for this page-based example. Configure GITHUB_ISSUES_OWNER/GITHUB_ISSUES_REPO to a smaller repo for the replace sync demo.',
        body
      );
    }

    throw new GitHubApiError(res.status, `GitHub request failed (${res.status})`, body);
  }
  return { data: (await res.json()) as T, link: res.headers.get('link') };
}

export function hasNextFromLink(link: string | null): boolean {
  if (!link) return false;
  return link.split(',').some((part) => part.includes('rel="next"'));
}

export function bumpCursorTimestamp(ts: string): string {
  const ms = new Date(ts).getTime();
  if (Number.isNaN(ms)) return ts;
  return new Date(Math.max(0, ms - 1000)).toISOString();
}

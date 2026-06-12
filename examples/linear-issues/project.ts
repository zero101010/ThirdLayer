import { table, field, sync, deploy, project, linearQuery } from '../../packages/authoring-sdk/src';
export { project };

// ============================================================================
// TABLE DEFINITIONS
// ============================================================================

const issues = table('linear_issues', {
  primaryKey: 'id',
  schema: {
    id: field.text(),
    title: field.text(),
    state: field.select(['backlog', 'todo', 'in_progress', 'done', 'cancelled']),
    assignee: field.text(),
    priority: field.number(),
    labels: field.multiSelect(),
    createdAt: field.datetime(),
    updatedAt: field.datetime(),
    isUrgent: field.boolean(),
  },
});

// ============================================================================
// SYNC DEFINITIONS
// ============================================================================

type LinearIssuesResponse = {
  issues: {
    nodes: Array<{
      id: string;
      title: string;
      state: { name: string };
      assignee?: { name: string } | null;
      priority: number;
      labels: { nodes: Array<{ name: string }> };
      createdAt: string;
      updatedAt: string;
    }>;
    pageInfo: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
  };
};

const ISSUES_QUERY = `
  query ListIssues($first: Int!, $after: String) {
    issues(first: $first, after: $after, orderBy: updatedAt) {
      nodes {
        id
        title
        state { name }
        assignee { name }
        priority
        labels { nodes { name } }
        createdAt
        updatedAt
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

function mapStateName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes('backlog')) return 'backlog';
  if (lower.includes('todo') || lower.includes('to do')) return 'todo';
  if (lower.includes('progress') || lower.includes('started')) return 'in_progress';
  if (lower.includes('done') || lower.includes('complete')) return 'done';
  if (lower.includes('cancel')) return 'cancelled';
  return 'todo';
}

sync('linear-issues', {
  table: issues,
  mode: 'replace',
  datasource: 'linear',
  schedule: '5m',
  async execute(state, context) {
    const after = typeof state?.cursor === 'string' ? state.cursor : null;

    const data = await linearQuery<LinearIssuesResponse>(
      ISSUES_QUERY,
      { first: 50, after },
      context
    );

    const nodes = data.issues.nodes;
    const pageInfo = data.issues.pageInfo;

    return {
      changes: nodes.map((issue) => ({
        type: 'upsert' as const,
        key: issue.id,
        values: {
          id: issue.id,
          title: issue.title,
          state: mapStateName(issue.state?.name ?? ''),
          assignee: issue.assignee?.name ?? '',
          priority: issue.priority,
          labels: issue.labels.nodes.map((l) => l.name),
          createdAt: issue.createdAt,
          updatedAt: issue.updatedAt,
          isUrgent: issue.priority === 1,
        },
      })),
      hasMore: pageInfo.hasNextPage,
      nextState: pageInfo.hasNextPage ? { cursor: pageInfo.endCursor } : undefined,
    };
  },
});

// ============================================================================
// DEPLOY
// ============================================================================

if (typeof require !== 'undefined' && require.main === module) {
  deploy({ projectName: 'linear-issues', destructive: true }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

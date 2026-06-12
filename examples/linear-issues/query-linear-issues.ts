/**
 * Example: Query Linear Issues using the Client SDK
 *
 * Assumes you've already deployed examples/linear-issues and have data synced.
 *
 * Usage:
 *   npx ts-node examples/linear-issues/query-linear-issues.ts
 */
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '.env') });

import { Client } from '../../packages/client-sdk/src';

const client = new Client({
  baseUrl: process.env.THIRDLAYER_BASE_URL || 'http://localhost:3000',
  tenantId: process.env.TENANT_ID || 'igor',
  tenantKey: process.env.TENANT_KEY || '',
});

async function main() {
  console.log('=== Linear Issues - Client SDK Examples ===\n');

  // 1. All in-progress issues
  console.log('--- 1. In-progress issues ---');
  const inProgress = await client.query({
    table: 'linear_issues',
    filter: { property: 'state', select: { equals: 'in_progress' } },
    sorts: [{ property: 'updatedAt', direction: 'descending' }],
    page_size: 10,
  });
  for (const row of inProgress.results) {
    console.log(`  [${row.values.state}] ${row.values.title} — assignee: ${row.values.assignee || 'unassigned'}`);
  }
  console.log(`  Found: ${inProgress.results.length}\n`);

  // 2. Urgent issues (priority = 1)
  console.log('--- 2. Urgent issues ---');
  const urgent = await client.query({
    table: 'linear_issues',
    filter: { property: 'isUrgent', checkbox: { equals: true } },
    page_size: 25,
  });
  for (const row of urgent.results) {
    console.log(`  [URGENT] ${row.values.title} (priority: ${row.values.priority})`);
  }
  console.log(`  Found: ${urgent.results.length}\n`);

  // 3. High priority issues (priority <= 2)
  console.log('--- 3. High priority issues (priority <= 2) ---');
  const highPriority = await client.query({
    table: 'linear_issues',
    filter: { property: 'priority', number: { lte: 2 } },
    sorts: [{ property: 'priority', direction: 'ascending' }],
    page_size: 10,
  });
  for (const row of highPriority.results) {
    console.log(`  P${row.values.priority}: ${row.values.title}`);
  }
  console.log(`  Found: ${highPriority.results.length}\n`);

  // 4. Issues in backlog
  console.log('--- 4. Backlog issues ---');
  const backlog = await client.query({
    table: 'linear_issues',
    filter: { property: 'state', select: { equals: 'backlog' } },
    sorts: [{ property: 'createdAt', direction: 'descending' }],
    page_size: 10,
  });
  for (const row of backlog.results) {
    console.log(`  ${row.values.title} — created: ${row.values.createdAt}`);
  }
  console.log(`  Found: ${backlog.results.length}\n`);

  // 5. Issues with a specific label
  console.log('--- 5. Issues with "bug" label ---');
  const bugs = await client.query({
    table: 'linear_issues',
    filter: { property: 'labels', multi_select: { contains: 'bug' } },
    page_size: 10,
  });
  for (const row of bugs.results) {
    console.log(`  ${row.values.title} — labels: ${row.values.labels}`);
  }
  console.log(`  Found: ${bugs.results.length}\n`);

  // 6. Issues containing keyword in title
  console.log('--- 6. Issues with "api" in title ---');
  const apiIssues = await client.query({
    table: 'linear_issues',
    filter: { property: 'title', text: { contains: 'api' } },
    page_size: 10,
  });
  for (const row of apiIssues.results) {
    console.log(`  ${row.values.title}`);
  }
  console.log(`  Found: ${apiIssues.results.length}\n`);

  // 7. Compound AND: in_progress AND urgent
  console.log('--- 7. In-progress AND urgent ---');
  const urgentInProgress = await client.query({
    table: 'linear_issues',
    filter: {
      and: [
        { property: 'state', select: { equals: 'in_progress' } },
        { property: 'isUrgent', checkbox: { equals: true } },
      ],
    },
    page_size: 10,
  });
  for (const row of urgentInProgress.results) {
    console.log(`  ${row.values.title} — assignee: ${row.values.assignee || 'unassigned'}`);
  }
  console.log(`  Found: ${urgentInProgress.results.length}\n`);

  // 8. Compound OR: done OR cancelled
  console.log('--- 8. Done OR cancelled ---');
  const completed = await client.query({
    table: 'linear_issues',
    filter: {
      or: [
        { property: 'state', select: { equals: 'done' } },
        { property: 'state', select: { equals: 'cancelled' } },
      ],
    },
    sorts: [{ property: 'updatedAt', direction: 'descending' }],
    page_size: 10,
  });
  for (const row of completed.results) {
    console.log(`  [${row.values.state}] ${row.values.title}`);
  }
  console.log(`  Found: ${completed.results.length}\n`);

  // 9. Issues assigned to a specific person
  console.log('--- 9. Issues by assignee (text contains) ---');
  const assigned = await client.query({
    table: 'linear_issues',
    filter: {
      and: [
        { property: 'assignee', text: { contains: '' } }, // non-empty assignee
        { property: 'state', select: { equals: 'in_progress' } },
      ],
    },
    page_size: 10,
  });
  for (const row of assigned.results) {
    console.log(`  ${row.values.assignee}: ${row.values.title}`);
  }
  console.log(`  Found: ${assigned.results.length}\n`);

  // 10. Issues created after a date
  console.log('--- 10. Issues created after 2024-01-01 ---');
  const recentIssues = await client.query({
    table: 'linear_issues',
    filter: { property: 'createdAt', datetime: { after: '2024-01-01T00:00:00Z' } },
    sorts: [{ property: 'createdAt', direction: 'descending' }],
    page_size: 10,
  });
  for (const row of recentIssues.results) {
    console.log(`  ${row.values.title} — ${row.values.createdAt}`);
  }
  console.log(`  Found: ${recentIssues.results.length}\n`);

  // 11. Pagination: all issues page by page
  console.log('--- 11. Pagination (all issues, 5 per page) ---');
  let cursor: string | null = null;
  let pageNum = 0;
  let total = 0;
  do {
    const page = await client.query({
      table: 'linear_issues',
      page_size: 5,
      start_cursor: cursor,
      sorts: [{ property: 'updatedAt', direction: 'descending' }],
    });
    pageNum++;
    total += page.results.length;
    console.log(`  Page ${pageNum}: ${page.results.length} results`);
    for (const row of page.results) {
      console.log(`    - ${row.values.title}`);
    }
    cursor = page.next_cursor ?? null;
  } while (cursor);
  console.log(`  Total fetched across ${pageNum} pages: ${total}\n`);

  // 12. Get a single row by key
  console.log('--- 12. Get single row ---');
  if (inProgress.results[0]) {
    const key = inProgress.results[0].key;
    const single = await client.getRow({ table: 'linear_issues', key });
    console.log(`  Row ${key}:`, JSON.stringify(single, null, 4));
  } else {
    console.log('  No rows to fetch');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

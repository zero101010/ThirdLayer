/**
 * Example: Query GitHub Pull Requests using the Client SDK
 *
 * Assumes you've already deployed examples/github-prs and have data synced.
 *
 * Usage:
 *   npx ts-node examples/github-prs/query-github-prs.ts
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
  console.log('=== GitHub Pull Requests - Client SDK Examples ===\n');

  // 1. All open PRs, most recently updated first
  console.log('--- 1. Open PRs (most recent) ---');
  const open = await client.query({
    table: 'pull_requests',
    filter: { property: 'state', select: { equals: 'open' } },
    sorts: [{ property: 'updatedAt', direction: 'descending' }],
    page_size: 10,
  });
  for (const row of open.results) {
    console.log(`  [${row.values.state}] ${row.values.title} (draft: ${row.values.isDraft})`);
  }
  console.log(`  Total: ${open.results.length}, has_more: ${open.has_more}\n`);

  // 2. Merged PRs
  console.log('--- 2. Merged PRs ---');
  const merged = await client.query({
    table: 'pull_requests',
    filter: { property: 'state', select: { equals: 'merged' } },
    sorts: [{ property: 'updatedAt', direction: 'descending' }],
    page_size: 10,
  });
  for (const row of merged.results) {
    console.log(`  ${row.values.title} by ${row.values.author}`);
  }
  console.log(`  Found: ${merged.results.length}\n`);

  // 3. Draft PRs only
  console.log('--- 3. Draft PRs ---');
  const drafts = await client.query({
    table: 'pull_requests',
    filter: { property: 'isDraft', checkbox: { equals: true } },
    page_size: 25,
  });
  for (const row of drafts.results) {
    console.log(`  [DRAFT] ${row.values.title}`);
  }
  console.log(`  Found: ${drafts.results.length}\n`);

  // 4. PRs with a specific label
  console.log('--- 4. PRs with "bug" label ---');
  const bugPRs = await client.query({
    table: 'pull_requests',
    filter: { property: 'labels', multi_select: { contains: 'bug' } },
    page_size: 10,
  });
  for (const row of bugPRs.results) {
    console.log(`  ${row.values.title} — labels: ${row.values.labels}`);
  }
  console.log(`  Found: ${bugPRs.results.length}\n`);

  // 5. PRs containing a keyword in the title
  console.log('--- 5. PRs with "fix" in title ---');
  const withFix = await client.query({
    table: 'pull_requests',
    filter: { property: 'title', text: { contains: 'fix' } },
    page_size: 10,
  });
  for (const row of withFix.results) {
    console.log(`  ${row.values.title}`);
  }
  console.log(`  Found: ${withFix.results.length}\n`);

  // 6. Compound AND: open AND not draft
  console.log('--- 6. Open non-draft PRs ---');
  const openReady = await client.query({
    table: 'pull_requests',
    filter: {
      and: [
        { property: 'state', select: { equals: 'open' } },
        { property: 'isDraft', checkbox: { equals: false } },
      ],
    },
    sorts: [{ property: 'updatedAt', direction: 'descending' }],
    page_size: 10,
  });
  for (const row of openReady.results) {
    console.log(`  ${row.values.title} by ${row.values.author}`);
  }
  console.log(`  Found: ${openReady.results.length}\n`);

  // 7. PRs updated after a specific date
  console.log('--- 7. PRs updated after 2024-01-01 ---');
  const recent = await client.query({
    table: 'pull_requests',
    filter: { property: 'updatedAt', datetime: { after: '2024-01-01T00:00:00Z' } },
    sorts: [{ property: 'updatedAt', direction: 'descending' }],
    page_size: 10,
  });
  for (const row of recent.results) {
    console.log(`  ${row.values.title} — updated: ${row.values.updatedAt}`);
  }
  console.log(`  Found: ${recent.results.length}\n`);

  // 8. Compound OR: draft OR closed
  console.log('--- 8. Draft OR closed PRs ---');
  const draftOrClosed = await client.query({
    table: 'pull_requests',
    filter: {
      or: [
        { property: 'isDraft', checkbox: { equals: true } },
        { property: 'state', select: { equals: 'closed' } },
      ],
    },
    page_size: 10,
  });
  for (const row of draftOrClosed.results) {
    console.log(`  ${row.values.title} (state: ${row.values.state}, draft: ${row.values.isDraft})`);
  }
  console.log(`  Found: ${draftOrClosed.results.length}\n`);

  // 9. Pagination: fetch all PRs page by page
  console.log('--- 9. Pagination (all PRs, 5 per page) ---');
  let cursor: string | null = null;
  let pageNum = 0;
  let total = 0;
  do {
    const page = await client.query({
      table: 'pull_requests',
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

  // 10. Get a single row by key
  console.log('--- 10. Get single row ---');
  if (open.results[0]) {
    const key = open.results[0].key;
    const single = await client.getRow({ table: 'pull_requests', key });
    console.log(`  Row ${key}:`, JSON.stringify(single, null, 4));
  } else {
    console.log('  No rows to fetch');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

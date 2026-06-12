/**
 * Example: Query GitHub Issues using the Client SDK
 *
 * Assumes you've already deployed examples/github-issues and have data synced.
 *
 * Usage:
 *   npx ts-node examples/github-issues/query-github-issues.ts
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
  console.log('=== GitHub Issues - Client SDK Examples ===\n');

  // 1. All open issues, newest first
  console.log('--- 1. Open issues (newest first) ---');
  const open = await client.query({
    table: 'issues',
    filter: { property: 'state', select: { equals: 'open' } },
    sorts: [{ property: 'createdAt', direction: 'descending' }],
    page_size: 10,
  });
  for (const row of open.results) {
    console.log(`  [${row.values.state}] ${row.values.title} (comments: ${row.values.comments})`);
  }
  console.log(`  Total: ${open.results.length}, has_more: ${open.has_more}\n`);

  // 2. Urgent issues only
  console.log('--- 2. Urgent issues ---');
  const urgent = await client.query({
    table: 'issues',
    filter: { property: 'isUrgent', checkbox: { equals: true } },
    page_size: 25,
  });
  for (const row of urgent.results) {
    console.log(`  [URGENT] ${row.values.title}`);
  }
  console.log(`  Found: ${urgent.results.length}\n`);

  // 3. Closed issues with more than 2 comments
  console.log('--- 3. Closed issues with >2 comments ---');
  const closedActive = await client.query({
    table: 'issues',
    filter: {
      and: [
        { property: 'state', select: { equals: 'closed' } },
        { property: 'comments', number: { gt: 2 } },
      ],
    },
    sorts: [{ property: 'comments', direction: 'descending' }],
    page_size: 10,
  });
  for (const row of closedActive.results) {
    console.log(`  ${row.values.title} — ${row.values.comments} comments`);
  }
  console.log(`  Found: ${closedActive.results.length}\n`);

  // 4. Issues containing a keyword in the title
  console.log('--- 4. Issues with "fix" in title ---');
  const withFix = await client.query({
    table: 'issues',
    filter: { property: 'title', text: { contains: 'fix' } },
    page_size: 10,
  });
  for (const row of withFix.results) {
    console.log(`  ${row.values.title}`);
  }
  console.log(`  Found: ${withFix.results.length}\n`);

  // 5. Compound OR filter: urgent OR has many comments
  console.log('--- 5. Urgent OR >5 comments ---');
  const urgentOrActive = await client.query({
    table: 'issues',
    filter: {
      or: [
        { property: 'isUrgent', checkbox: { equals: true } },
        { property: 'comments', number: { gt: 5 } },
      ],
    },
    page_size: 10,
  });
  for (const row of urgentOrActive.results) {
    console.log(`  ${row.values.title} (urgent: ${row.values.isUrgent}, comments: ${row.values.comments})`);
  }
  console.log(`  Found: ${urgentOrActive.results.length}\n`);

  // 6. Pagination example: fetch all issues page by page
  console.log('--- 6. Pagination (all issues, 3 per page) ---');
  let cursor: string | null = null;
  let pageNum = 0;
  let total = 0;
  do {
    const page = await client.query({
      table: 'issues',
      page_size: 3,
      start_cursor: cursor,
      sorts: [{ property: 'createdAt', direction: 'descending' }],
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

  // 7. Get a single row by key
  console.log('--- 7. Get single row ---');
  if (open.results[0]) {
    const key = open.results[0].key;
    const single = await client.getRow({ table: 'issues', key });
    console.log(`  Row ${key}:`, JSON.stringify(single, null, 4));
  } else {
    console.log('  No rows to fetch');
  }
  console.log();

  // 8. Update a row
  console.log('--- 8. Update a row (set state to closed, then revert) ---');
  if (open.results[0]) {
    const key = open.results[0].key;
    const original = open.results[0].values.state;
    await client.updateRow({ table: 'issues', key, values: { state: 'closed' } });
    const updated = await client.getRow({ table: 'issues', key });
    console.log(`  After update: state = ${(updated as any)?.values?.state}`);
    // Revert
    await client.updateRow({ table: 'issues', key, values: { state: original } });
    console.log(`  Reverted to: state = ${original}`);
  } else {
    console.log('  No rows to update');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

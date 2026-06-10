import { Client, QueryRequest } from '../packages/client-sdk/src';

async function main() {
  const tenantId = process.env.TENANT_ID || 'default';
  const tenantKey = process.env.TENANT_KEY || '';
  const client = new Client({ baseUrl: 'http://localhost:3000', tenantId, tenantKey });

  const req: QueryRequest = {
    table: 'issues',
    filter: {
      and: [
        { property: 'state', select: { equals: 'open' } },
        { property: 'isUrgent', checkbox: { equals: false } },
      ],
    },
    page_size: 10,
  };

  const res = await client.query(req);
  console.log('Query response:', JSON.stringify(res, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

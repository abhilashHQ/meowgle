import { now } from '../src/clock.js';
import { config } from '../src/config.js';
import { insertClaim, insertTurn, openDb } from '../src/db.js';
import { localDateOf, resolveDates } from '../src/dates.js';

type SeedSource = {
  id: string;
  url: string;
  title: string;
  publishedDate: string | null;
};

type SeedClaim = {
  subject: string;
  claim: string;
  sourceId: string;
};

type SeedConversation = {
  user: string;
  answer: string;
  queries: string[];
  reason: string;
  sources: SeedSource[];
  claims: SeedClaim[];
  date: string;
};

function citedIds(answer: string, sources: SeedSource[]): string[] {
  const known = new Set(sources.map((source) => source.id));
  const seen = new Set<string>();
  for (const match of answer.matchAll(/\[(S\d+)\]/g)) {
    if (known.has(match[1])) seen.add(match[1]);
  }
  return [...seen];
}

function main(): void {
  const force = process.argv.includes('--force');
  const tz = process.env.SEED_TZ || 'Asia/Kolkata';
  const clockNow = now();
  const today = localDateOf(clockNow, tz);

  const novemberThird =
    resolveDates('3 November', clockNow, tz)[0]?.start ?? `${today.slice(0, 4)}-11-03`;
  const monday = resolveDates('last monday', clockNow, tz)[0]?.start;
  const tuesday = resolveDates('last tuesday', clockNow, tz)[0]?.start;
  if (!monday || !tuesday) {
    console.error('Could not resolve the seed dates from the clock.');
    process.exit(1);
  }

  const db = openDb(config.dbPath);
  const existing = db.prepare('SELECT COUNT(*) AS count FROM turns').get() as unknown as {
    count: number;
  };
  if (existing.count > 0 && !force) {
    console.error(
      `Refusing to seed: ${existing.count} turns already exist in ${config.dbPath}. Use --force to clear them.`,
    );
    db.close();
    process.exit(1);
  }
  if (existing.count > 0) {
    db.exec('DELETE FROM claims; DELETE FROM turns;');
  }

  const conversations: SeedConversation[] = [
    {
      date: novemberThird,
      user: 'What are the free tier limits of Supabase and Neon?',
      answer:
        "Supabase's free plan gives you 500 MB of database storage, 5 GB of egress, and 50,000 monthly active users [S1]. Free projects pause after seven days without activity [S1]. Neon's free plan gives you 0.5 GB of storage per project and 191.9 compute hours per month, and projects scale to zero after five minutes idle [S2]. Both plans move you to paid billing once you pass the included allowance: Supabase switches the project to usage-based billing, while Neon bills extra storage at $0.35 per GB-month [S1][S2].\n\nBoth are fine for a prototype. Pick Supabase if you want auth and file storage in the same product; pick Neon if you want a plain Postgres endpoint.",
      queries: ['Supabase free tier limits 2026', 'Neon free tier limits 2026'],
      reason: 'needs current free tier limits for two hosted Postgres vendors',
      sources: [
        {
          id: 'S1',
          url: 'https://supabase.com/pricing',
          title: 'Supabase Pricing',
          publishedDate: '2025-09-18',
        },
        {
          id: 'S2',
          url: 'https://neon.com/pricing',
          title: 'Neon Pricing',
          publishedDate: '2025-10-02',
        },
      ],
      claims: [
        {
          subject: 'Supabase free tier limits',
          claim:
            "Supabase's free plan includes 500 MB of database storage, 5 GB of egress, and 50,000 monthly active users.",
          sourceId: 'S1',
        },
        {
          subject: 'Supabase free project pausing',
          claim: 'Supabase free projects pause after seven days without activity.',
          sourceId: 'S1',
        },
        {
          subject: 'Neon free tier limits',
          claim:
            "Neon's free plan includes 0.5 GB of storage per project and 191.9 compute hours per month.",
          sourceId: 'S2',
        },
        {
          subject: 'Neon scale to zero',
          claim: 'Neon free projects scale to zero after five minutes idle.',
          sourceId: 'S2',
        },
        {
          subject: 'Supabase overage billing',
          claim: 'Supabase moves free projects to usage-based billing after the included allowance.',
          sourceId: 'S1',
        },
      ],
    },
    {
      date: monday,
      user: 'Shortlist 5 CRM tools for a 20-person sales team',
      answer:
        'For a 20-person team, five CRMs cover the usual spread:\n\n- HubSpot Sales Hub: Starter is $20 per seat per month, Professional is $100 per seat per month [S1].\n- Pipedrive: Essential is $14 per seat per month billed annually, Advanced is $34 [S2].\n- Salesforce Starter Suite: $25 per user per month [S3].\n- Zoho CRM: Standard is $14 per user per month, Professional is $23 [S4].\n- Close: Essential is $29 per user per month billed annually, Professional is $99 [S5].\n\nAt list price for 20 seats, the annual spread runs from about $3,360 on Pipedrive Essential to $24,000 on HubSpot Professional [S1][S2].',
      queries: ['best CRM for small sales team 2026 pricing', 'CRM pricing comparison 2026'],
      reason: 'needs current vendor pricing for a shortlist',
      sources: [
        {
          id: 'S1',
          url: 'https://www.hubspot.com/pricing/sales',
          title: 'HubSpot Sales Hub Pricing',
          publishedDate: '2025-08-20',
        },
        {
          id: 'S2',
          url: 'https://www.pipedrive.com/en/pricing',
          title: 'Pipedrive Pricing',
          publishedDate: '2025-09-05',
        },
        {
          id: 'S3',
          url: 'https://www.salesforce.com/sales/starter-suite/pricing/',
          title: 'Salesforce Starter Suite Pricing',
          publishedDate: '2025-07-30',
        },
        {
          id: 'S4',
          url: 'https://www.zoho.com/crm/zohocrm-pricing.html',
          title: 'Zoho CRM Pricing',
          publishedDate: '2025-09-22',
        },
        {
          id: 'S5',
          url: 'https://www.close.com/pricing',
          title: 'Close Pricing',
          publishedDate: '2025-06-14',
        },
      ],
      claims: [
        {
          subject: 'HubSpot Sales Hub pricing',
          claim:
            'HubSpot Sales Hub Starter costs $20 per seat per month and Professional costs $100 per seat per month.',
          sourceId: 'S1',
        },
        {
          subject: 'Pipedrive pricing',
          claim:
            'Pipedrive Essential costs $14 per seat per month billed annually and Advanced costs $34.',
          sourceId: 'S2',
        },
        {
          subject: 'Salesforce Starter Suite pricing',
          claim: 'Salesforce Starter Suite costs $25 per user per month.',
          sourceId: 'S3',
        },
        {
          subject: 'Zoho CRM pricing',
          claim: 'Zoho CRM Standard costs $14 per user per month and Professional costs $23.',
          sourceId: 'S4',
        },
        {
          subject: 'Close pricing',
          claim:
            'Close Essential costs $29 per user per month billed annually and Professional costs $99.',
          sourceId: 'S5',
        },
      ],
    },
    {
      date: tuesday,
      user: 'What does Postgres hosting cost on Supabase, Neon, RDS?',
      answer:
        'Supabase Pro is $25 per month for the first project, including 8 GB of database storage [S1]. Compute is billed separately: a 2-core, 4 GB instance runs about $55 per month [S1]. Neon Launch is usage-based at $0.102 per compute hour for a 4 GB instance [S2] plus $0.35 per GB-month of storage [S2]. On AWS, a db.t4g.micro RDS for PostgreSQL instance with 20 GB of gp3 storage is roughly $15 per month on demand in us-east-1, before backups and I/O [S3]. A one-year reserved instance cuts the compute portion by about 40 percent [S3].',
      queries: ['Supabase Postgres pricing 2026', 'Neon Postgres pricing 2026', 'RDS PostgreSQL pricing us-east-1 2026'],
      reason: 'needs current hosted Postgres pricing across three vendors',
      sources: [
        {
          id: 'S1',
          url: 'https://supabase.com/pricing',
          title: 'Supabase Pricing',
          publishedDate: '2025-09-18',
        },
        {
          id: 'S2',
          url: 'https://neon.com/pricing',
          title: 'Neon Pricing',
          publishedDate: '2025-10-02',
        },
        {
          id: 'S3',
          url: 'https://aws.amazon.com/rds/postgresql/pricing/',
          title: 'Amazon RDS for PostgreSQL Pricing',
          publishedDate: '2025-10-10',
        },
      ],
      claims: [
        {
          subject: 'Supabase Pro pricing',
          claim: 'Supabase Pro costs $25 per month for the first project and includes 8 GB of database storage.',
          sourceId: 'S1',
        },
        {
          subject: 'Supabase compute pricing',
          claim: 'A 2-core, 4 GB Supabase compute instance costs about $55 per month.',
          sourceId: 'S1',
        },
        {
          subject: 'Neon compute pricing',
          claim: 'Neon Launch charges $0.102 per compute hour for a 4 GB instance.',
          sourceId: 'S2',
        },
        {
          subject: 'Neon storage pricing',
          claim: 'Neon Launch charges $0.35 per GB-month of storage.',
          sourceId: 'S2',
        },
        {
          subject: 'RDS on-demand pricing',
          claim:
            'A db.t4g.micro RDS for PostgreSQL instance with 20 GB of gp3 storage costs roughly $15 per month on demand in us-east-1.',
          sourceId: 'S3',
        },
        {
          subject: 'RDS reserved instance discount',
          claim: 'A one-year reserved RDS instance cuts the compute price by about 40 percent.',
          sourceId: 'S3',
        },
      ],
    },
  ];

  let claimCount = 0;
  const report: string[] = [];
  for (const conversation of conversations) {
    const createdAt = `${conversation.date}T12:00:00.000Z`;
    insertTurn(db, {
      conversationId: 'seed-demo',
      role: 'user',
      content: conversation.user,
      createdAt,
      localDate: conversation.date,
      tz,
    });
    const assistantTrace = {
      recall: {
        dateRefs: [],
        counts: { turns: 0, byDate: 0, topical: 0, recent: 0, claims: 0 },
        nearby: [],
      },
      plan: {
        level: 'quick',
        queries: conversation.queries,
        recheckClaimIds: [],
        reason: conversation.reason,
      },
      search: {
        queries: conversation.queries,
        sources: conversation.sources,
        ms: 1450,
      },
      citations: { valid: citedIds(conversation.answer, conversation.sources), invalid: [] },
      timings: {
        recallMs: 3,
        planMs: 620,
        searchMs: 1450,
        firstTokenMs: 740,
        totalMs: 5900,
      },
    };
    const assistantTurnId = insertTurn(db, {
      conversationId: 'seed-demo',
      role: 'assistant',
      content: conversation.answer,
      createdAt,
      localDate: conversation.date,
      tz,
      level: 'quick',
      traceJson: JSON.stringify(assistantTrace),
    });
    for (const claim of conversation.claims) {
      const source = conversation.sources.find((item) => item.id === claim.sourceId);
      if (!source) throw new Error(`unknown seed source ${claim.sourceId}`);
      insertClaim(db, assistantTurnId, {
        subject: claim.subject,
        claim: claim.claim,
        sourceUrl: source.url,
        sourceTitle: source.title,
        publishedDate: source.publishedDate,
        fetchedAt: createdAt,
      });
      claimCount++;
    }
    report.push(`- ${conversation.date}  ${conversation.user}  (${conversation.claims.length} claims)`);
  }

  console.log(`Seeded ${conversations.length} Q&A pairs into ${config.dbPath} (${tz}).`);
  for (const line of report) console.log(line);
  console.log(
    `Inserted ${conversations.length} user turns, ${conversations.length} assistant turns, ${claimCount} claims.`,
  );
  db.close();
}

main();

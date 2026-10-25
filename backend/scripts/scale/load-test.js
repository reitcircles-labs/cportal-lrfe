#!/usr/bin/env node
/**
 * The load tests of API-769, against a running PostgreSQL stack holding the test register
 * (generate.js). Each operation runs alone (one request at a time) and under load (several
 * officers at once); new-document matching files documents one by one and in a burst. The report
 * gives the median and 95th percentile per operation, the throughput, the database time and rows
 * read per request, and the targets (targets.json) each one meets or misses. See README.md.
 *
 *   node scripts/scale/load-test.js [--concurrency 8] [--duration 20] [--samples 30]
 *                                   [--filings 20] [--burst 100] [--only Suggestions] [--out report.md]
 */
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import pg from 'pg';
import {JWT_SECRET, PORTS} from '../../../e2e/stack/config.mjs';
import {
  createFiling,
  createOperations,
  officerToken,
  sampleInputs,
  workListCompleteness,
} from './operations.js';

const {values: options} = parseArgs({
  options: {
    concurrency: {type: 'string', default: '8'},
    duration: {type: 'string', default: '20'},
    samples: {type: 'string', default: '30'},
    filings: {type: 'string', default: '20'},
    burst: {type: 'string', default: '100'},
    only: {type: 'string'},
    seed: {type: 'string', default: '769'},
    out: {type: 'string'},
    targets: {
      type: 'string',
      default: fileURLToPath(new URL('./targets.json', import.meta.url)),
    },
  },
});
const concurrency = Number(options.concurrency);
const durationMs = Number(options.duration) * 1000;
const samples = Number(options.samples);
const targets = JSON.parse(readFileSync(options.targets, 'utf8'));
// the load test's own queries are marked, so the database load counts the services' only
const OWN = '/* load-test */';

/** Milliseconds as a whole number, or a dash when there is none. */
/** The value below which `share` of the sorted values lie (nearest rank). */
function percentile(sorted, share) {
  if (!sorted.length) return null;
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)
  ];
}

function summary(times) {
  const sorted = [...times].sort((a, b) => a - b);
  return {
    count: sorted.length,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1] ?? null,
  };
}

/**
 * The database's work since the last reset: statements' time and calls, rows read (approximate:
 * index scans count some rows twice), the costliest statement.
 */
async function databaseLoad(db, hasStatements) {
  // the server publishes its counters up to a second late
  await new Promise(resolve => setTimeout(resolve, 1100));
  const [stats] = (
    await db.query(
      `${OWN} SELECT "tup_returned" + "tup_fetched" AS "rows", "blks_read" AS "diskBlocks" FROM pg_stat_database WHERE datname = current_database()`,
    )
  ).rows;
  if (!hasStatements) return {...stats, timeMs: null, calls: null, top: null};
  const {rows} = await db.query(
    `${OWN} SELECT "query", "calls", "total_exec_time" AS "ms" FROM pg_stat_statements
      WHERE "dbid" = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND "query" NOT LIKE '%load-test%' ORDER BY "total_exec_time" DESC`,
  );
  return {
    ...stats,
    timeMs: rows.reduce((sum, row) => sum + row.ms, 0),
    calls: rows.reduce((sum, row) => sum + Number(row.calls), 0),
    top: rows[0] ? rows[0].query.replace(/\s+/g, ' ').slice(0, 160) : null,
  };
}

async function resetLoad(db, hasStatements) {
  await db.query(`${OWN} SELECT pg_stat_reset()`);
  if (hasStatements) await db.query(`${OWN} SELECT pg_stat_statements_reset()`);
}

/** Runs `operation` with `workers` at once until `until` (ms) or `limit` requests: their times. */
async function run(operation, {workers, until, limit = Infinity}) {
  const times = [];
  const errors = [];
  let started = 0;
  const worker = async () => {
    while (performance.now() < until && started < limit) {
      started += 1;
      const requestStart = performance.now();
      try {
        await operation();
        times.push(performance.now() - requestStart);
      } catch (err) {
        errors.push(err.message);
      }
    }
  };
  const runStart = performance.now();
  await Promise.all(Array.from({length: workers}, worker));
  return {times, errors, seconds: (performance.now() - runStart) / 1000};
}

async function measure(name, operation, db, hasStatements) {
  await run(operation, {workers: 1, until: Infinity, limit: 3}); // warm up
  const alone = await run(operation, {
    workers: 1,
    until: performance.now() + 120_000,
    limit: samples,
  });
  await resetLoad(db, hasStatements);
  const loaded = await run(operation, {
    workers: concurrency,
    until: performance.now() + durationMs,
  });
  const load = await databaseLoad(db, hasStatements);
  const requests = loaded.times.length || 1;
  const result = {
    name,
    alone: summary(alone.times),
    loaded: summary(loaded.times),
    throughput: loaded.times.length / loaded.seconds,
    errors: [...alone.errors, ...loaded.errors],
    dbMsPerRequest: load.timeMs === null ? null : load.timeMs / requests,
    statementsPerRequest: load.calls === null ? null : load.calls / requests,
    rowsPerRequest: Number(load.rows) / requests,
    topStatement: load.top,
    target: targets.responseTimesMs[name] ?? null,
  };
  console.log(
    `${name}: alone ${fmt(result.alone.median)} / ${fmt(result.alone.p95)} ms, ` +
      `${concurrency} at once ${fmt(result.loaded.median)} / ${fmt(result.loaded.p95)} ms, ` +
      `${result.throughput.toFixed(1)} req/s${result.errors.length ? `, ${result.errors.length} errors (${result.errors[0]})` : ''}`,
  );
  return result;
}

/** New-document matching (API-766): filings one at a time, then a burst; filed to flagged. */
async function measureMatching(filing) {
  const errors = [];
  const fileOne = async parcel => {
    try {
      return await filing.file(parcel);
    } catch (err) {
      errors.push(err.message);
      return null;
    }
  };
  const one = [];
  let missed = 0;
  for (const parcel of await filing.parcels(Number(options.filings))) {
    const filed = await fileOne(parcel);
    if (!filed) continue;
    const result = await filing.flagged([filed], 60_000);
    one.push(...result.times);
    missed += result.missed;
  }
  const burstParcels = await filing.parcels(Number(options.burst));
  const burstStart = performance.now();
  const filed = [];
  const queue = [...burstParcels];
  await Promise.all(
    Array.from({length: concurrency}, async () => {
      while (queue.length) {
        const filedOne = await fileOne(queue.shift());
        if (filedOne) filed.push(filedOne);
      }
    }),
  );
  const filedSeconds = (performance.now() - burstStart) / 1000;
  const burst = await filing.flagged(filed, 600_000);
  const allSeconds = (performance.now() - burstStart) / 1000;
  const result = {
    errors,
    one: {...summary(one), missed},
    burst: {
      ...summary(burst.times),
      documents: filed.length,
      missed: burst.missed,
      filedSeconds,
      allSeconds,
      perMinute: (burst.times.length / allSeconds) * 60,
    },
  };
  console.log(
    `New-document matching: one at a time ${fmt(result.one.median)} / ${fmt(result.one.p95)} ms; ` +
      `burst of ${filed.length}: all flagged in ${allSeconds.toFixed(1)} s (${result.burst.perMinute.toFixed(0)}/min), ` +
      `p95 ${fmt(result.burst.p95)} ms, ${burst.missed} not flagged` +
      `${errors.length ? `, ${errors.length} filings failed (${errors[0]})` : ''}`,
  );
  return result;
}

const fmt = ms => (ms === null ? '–' : String(Math.round(ms)));

/** The work list each operation reads, for its completeness. */
const WORK_LIST_OF = {
  'Work list: in review': 'in_review',
  'Work list: needs review': 'needs_review',
  'Work list: new document': 'new_document',
  'Work list: drafts': 'draft',
};

/**
 * Whether the 95th percentile under load meets its target. A failed request misses it, and so
 * does a work list that leaves records out, however fast.
 */
function verdict(result, workLists) {
  if (!result.target) return '';
  const list = workLists.find(
    entry => entry.status === WORK_LIST_OF[result.name],
  );
  if (list && list.shown !== list.inDatabase) return '**misses** (incomplete)';
  const met = !result.errors.length && result.loaded.p95 <= result.target.p95;
  return met ? 'meets' : '**misses**';
}

function report({register, results, matching, workLists, startedAt}) {
  const lines = [
    `# Load test report`,
    '',
    `${startedAt.toISOString()} · ${register.documents} documents, ${register.records} land records ` +
      `(${register.flagged} flagged), database ${register.size} · ${concurrency} requests at once for ` +
      `${options.duration} s per operation · times in ms`,
    '',
    `| Operation | Alone median | Alone p95 | Under load median | Under load p95 | Failed | Requests/s | DB ms/request | Statements/request | Rows read/request (approx.) | Target p95 | |`,
    `|---|---|---|---|---|---|---|---|---|---|---|---|`,
  ];
  for (const result of results) {
    lines.push(
      `| ${result.name} | ${fmt(result.alone.median)} | ${fmt(result.alone.p95)} | ${fmt(result.loaded.median)} | ${fmt(result.loaded.p95)} | ${result.errors.length} | ` +
        `${result.throughput.toFixed(1)} | ${fmt(result.dbMsPerRequest)} | ${result.statementsPerRequest?.toFixed(1) ?? '–'} | ` +
        `${Math.round(result.rowsPerRequest)} | ${result.target ? result.target.p95 : '–'} | ${verdict(result, workLists)} |`,
    );
  }
  if (matching) {
    const target = targets.filingToFlagMs;
    const {one, burst} = matching;
    lines.push(
      '',
      `## New-document matching (filed to flagged)`,
      '',
      `| Case | Documents | Median | p95 | Max | Not flagged | Throughput | Target |`,
      `|---|---|---|---|---|---|---|---|`,
      `| One at a time | ${one.count} | ${fmt(one.median)} | ${fmt(one.p95)} | ${fmt(one.max)} | ${one.missed} | – | p95 ${target.p95} |`,
      `| Burst | ${burst.documents} | ${fmt(burst.median)} | ${fmt(burst.p95)} | ${fmt(burst.max)} | ${burst.missed} | ${burst.perMinute.toFixed(0)}/min (all in ${burst.allSeconds.toFixed(1)} s) | ${targets.filingThroughputPerMinute}/min |`,
    );
  }
  lines.push(
    '',
    `## Work lists: records shown against records in the database`,
    '',
    `| Work list | Total the screen gets | In the database | |`,
    `|---|---|---|---|`,
    ...workLists.map(
      list =>
        `| ${list.status} | ${list.shown} | ${list.inDatabase} | ${list.shown === list.inDatabase ? 'complete' : '**records missing**'} |`,
    ),
  );
  if (matching?.errors.length) {
    lines.push(
      '',
      `${matching.errors.length} filings failed: ${matching.errors[0]}`,
    );
  }
  lines.push('', `## Costliest statement per operation`, '');
  for (const result of results) {
    lines.push(
      `- **${result.name}**: \`${result.topStatement ?? 'not measured'}\``,
    );
  }
  const failed = results.filter(result => result.errors.length);
  if (failed.length) {
    lines.push('', '## Errors', '');
    for (const result of failed) {
      lines.push(
        `- **${result.name}**: ${result.errors.length} (${result.errors[0]})`,
      );
    }
  }
  return lines.join('\n') + '\n';
}

const db = new pg.Client({
  connectionString:
    process.env.SCALE_DATABASE_URL ||
    `postgres://lrfe@127.0.0.1:${PORTS.postgres}/e2e`,
});
await db.connect();
try {
  const startedAt = new Date();
  let hasStatements = true;
  try {
    await db.query(`${OWN} CREATE EXTENSION IF NOT EXISTS pg_stat_statements`);
    await db.query(`${OWN} SELECT pg_stat_statements_reset()`);
  } catch (err) {
    hasStatements = false;
    console.warn(
      `Database time per statement not measured (${err.message}): start the stack with E2E_PG_DIR`,
    );
  }
  const [register] = (
    await db.query(
      `${OWN} SELECT (SELECT count(*) FROM "edrms"."document")::int AS "documents",
              (SELECT count(*) FROM "records"."land_record")::int AS "records",
              (SELECT count(*) FROM "records"."land_record" WHERE "flags" <> '[]')::int AS "flagged",
              pg_size_pretty(pg_database_size(current_database())) AS "size"`,
    )
  ).rows;
  console.log(
    `Register: ${register.documents} documents, ${register.records} land records, database ${register.size}`,
  );
  const gatewayUrl = `http://127.0.0.1:${PORTS.gateway}`;
  const token = officerToken(JWT_SECRET);
  const operations = createOperations({
    gatewayUrl,
    token,
    inputs: await sampleInputs(db),
    seed: Number(options.seed),
  });
  const results = [];
  for (const [name, operation] of Object.entries(operations)) {
    if (options.only && !name.includes(options.only)) continue;
    results.push(await measure(name, operation, db, hasStatements));
  }
  const matching =
    !options.only || 'New-document matching'.includes(options.only)
      ? await measureMatching(
          createFiling({
            edrmsUrl: `http://127.0.0.1:${PORTS.edrms}`,
            secret: JWT_SECRET,
            db,
          }),
        )
      : null;
  const workLists = await workListCompleteness({gatewayUrl, token, db});
  const text = report({register, results, matching, workLists, startedAt});
  console.log(`\n${text}`);
  if (options.out) {
    writeFileSync(options.out, text);
    writeFileSync(
      options.out.replace(/\.md$/, '') + '.json',
      JSON.stringify(
        {register, results, matching, workLists, startedAt},
        null,
        2,
      ),
    );
    console.log(`Report written to ${options.out}`);
  }
} finally {
  await db.end();
}

#!/usr/bin/env node
/**
 * Fills a PostgreSQL stack with the synthetic national register of the load tests (API-769):
 * filed documents in edrms and land records in land-records, written straight into the services'
 * tables, as the services would have written them. See README.md in this folder.
 *
 *   node scripts/scale/generate.js --parcels 100000 [--seed 769] [--records 0.8] [--replace]
 *   node scripts/scale/generate.js --documents 500000      (about 5.1 documents per parcel)
 *
 * The database is the load-test stack's (e2e/stack, E2E_API_PORT + 6), or DB_CONNECTION_STRING.
 * The services must have started on it once, so their tables exist. Without --replace it refuses
 * a database that already holds documents or records.
 */
import {parseArgs} from 'node:util';
import pg from 'pg';
import {PORTS} from '../../../e2e/stack/config.mjs';
import {createRandom} from './random.js';
import {RecordsBuilder} from './records.js';
import {RegisterBuilder} from './register.js';

/** Country profiles: what the register's numbers, names and amounts look like. */
const PROFILES = {
  NA: {
    country: 'NA',
    registry: 'WDH',
    currency: 'N$',
    idDigits: 11,
    regDivs: [...'ABCDEFGHIJKLMNOPQRSTUVW'],
    regions: 14,
    erfShare: 0.85,
  },
};
/** The documents a parcel has on average in this register: turns --documents into parcels. */
const DOCUMENTS_PER_PARCEL = 5.1;
/** Parcels written per transaction. */
const BATCH = 500;

const {values: options} = parseArgs({
  options: {
    parcels: {type: 'string'},
    documents: {type: 'string'},
    seed: {type: 'string', default: '769'},
    records: {type: 'string', default: '0.8'},
    profile: {type: 'string', default: 'NA'},
    'as-of': {type: 'string', default: '2026-10-01'},
    'scan-years': {type: 'string', default: '2'},
    'record-years': {type: 'string', default: '1'},
    replace: {type: 'boolean', default: false},
  },
});

const profile = PROFILES[options.profile];
if (!profile) {
  throw new Error(
    `Unknown profile "${options.profile}" (known: ${Object.keys(PROFILES).join(', ')})`,
  );
}
const parcels = options.parcels
  ? Number(options.parcels)
  : Math.round(Number(options.documents || 50_000) / DOCUMENTS_PER_PARCEL);
const seed = Number(options.seed);
const recordShare = Number(options.records);
const asOf = new Date(`${options['as-of']}T00:00:00Z`);
if (!(parcels > 0) || !(recordShare >= 0 && recordShare <= 1)) {
  throw new Error('--parcels (or --documents) > 0 and --records 0..1 needed');
}

const TABLES = {
  documents: '"edrms"."document"',
  documentVersions: '"edrms"."document_version"',
  documentCounter: '"edrms"."counter"',
  records: '"records"."land_record"',
  recordVersions: '"records"."record_version"',
  recordCounter: '"records"."counter"',
  comments: '"records"."record_comment"',
};

/** Insert rows (plain objects keyed by column) as one statement: a JSON array turned into rows. */
async function insert(client, table, rows) {
  if (!rows.length) return;
  const columns = [...new Set(rows.flatMap(r => Object.keys(r)))]
    .map(c => `"${c}"`)
    .join(', ');
  await client.query(
    `INSERT INTO ${table} (${columns}) SELECT ${columns} FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb)`,
    [JSON.stringify(rows)],
  );
}

async function writeBatch(client, batch) {
  await client.query('BEGIN');
  await insert(client, TABLES.documents, batch.documents);
  await insert(client, TABLES.documentVersions, batch.documentVersions);
  await insert(client, TABLES.records, batch.records);
  await insert(client, TABLES.recordVersions, batch.recordVersions);
  await client.query('COMMIT');
}

/** Year counters, so numbers handed out after the register continue from it. */
async function writeCounters(client, table, counters) {
  for (const {year, last} of counters) {
    await client.query(
      `INSERT INTO ${table} ("year", "last") VALUES ($1, $2)
         ON CONFLICT ("year") DO UPDATE SET "last" = GREATEST(${table}."last", EXCLUDED."last")`,
      [year, last],
    );
  }
}

async function prepare(client) {
  const [{n: documents}] = (
    await client.query(`SELECT count(*)::int AS n FROM ${TABLES.documents}`)
  ).rows;
  const [{n: records}] = (
    await client.query(`SELECT count(*)::int AS n FROM ${TABLES.records}`)
  ).rows;
  if ((documents || records) && !options.replace) {
    throw new Error(
      `The database already holds ${documents} documents and ${records} records: --replace empties it first`,
    );
  }
  if (options.replace) {
    await client.query(
      `TRUNCATE ${Object.values(TABLES).join(', ')}, "edrms"."outbox", "records"."outbox"`,
    );
  }
}

const client = new pg.Client({
  connectionString:
    process.env.DB_CONNECTION_STRING ||
    `postgres://lrfe@127.0.0.1:${PORTS.postgres}/e2e`,
});
await client.connect();
try {
  await prepare(client);
  const register = new RegisterBuilder({
    seed,
    parcels,
    profile,
    asOf,
    scanYears: Number(options['scan-years']),
  });
  // records draw from their own sequence, so --records does not change the documents
  const recordsRandom = createRandom(seed + 1);
  const records = new RecordsBuilder({
    random: recordsRandom,
    profile,
    asOf,
    parcels,
    years: Number(options['record-years']),
  });
  const totals = {documents: 0, versions: 0, records: 0, states: {}};
  const started = Date.now();
  let batch = null;
  let pending = Promise.resolve();
  const flush = async () => {
    await pending; // one batch in the database while the next one is built
    pending = writeBatch(client, batch);
    batch = null;
  };

  for (const {index, documents} of register.parcels()) {
    batch ??= {
      documents: [],
      documentVersions: [],
      records: [],
      recordVersions: [],
    };
    const built = recordsRandom.chance(recordShare)
      ? records.build(index, documents)
      : null;
    for (const {document, versions} of documents) {
      batch.documents.push(document);
      batch.documentVersions.push(...versions);
      totals.versions += versions.length;
    }
    totals.documents += documents.length;
    if (built) {
      batch.records.push(built.record);
      batch.recordVersions.push(...built.versions);
      totals.records += 1;
      totals.states[built.state] = (totals.states[built.state] ?? 0) + 1;
    }
    if ((index + 1) % BATCH === 0) {
      await flush();
      if ((index + 1) % (BATCH * 20) === 0) {
        const seconds = (Date.now() - started) / 1000;
        const rate = Math.round(totals.documents / seconds);
        console.log(
          `${index + 1} parcels, ${totals.documents} documents, ${totals.records} records (${rate} documents/s)`,
        );
      }
    }
  }
  if (batch) await flush();
  await pending;
  await writeCounters(client, TABLES.documentCounter, register.counters());
  await writeCounters(client, TABLES.recordCounter, records.yearCounters());
  console.log('Analysing the tables…');
  for (const table of [
    TABLES.documents,
    TABLES.documentVersions,
    TABLES.records,
    TABLES.recordVersions,
  ]) {
    await client.query(`ANALYZE ${table}`);
  }
  const [{size}] = (
    await client.query(
      'SELECT pg_size_pretty(pg_database_size(current_database())) AS size',
    )
  ).rows;
  console.log(
    JSON.stringify(
      {
        seed,
        parcels,
        ...totals,
        // records the land-records schema would refuse: left out (there should be none)
        invalidRecords: records.invalid,
        databaseSize: size,
        seconds: Math.round((Date.now() - started) / 1000),
      },
      null,
      2,
    ),
  );
} finally {
  await client.end();
}

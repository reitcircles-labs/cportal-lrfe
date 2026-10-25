#!/usr/bin/env node
/**
 * Fills a PostgreSQL stack with the synthetic national register of the load tests (API-769):
 * filed documents in edrms and land records in land-records, written straight into the services'
 * tables, as the services would have written them. See README.md in this folder.
 *
 *   node scripts/scale/generate.js --parcels 100000 [--seed 769] [--records 0.8] [--replace]
 *   node scripts/scale/generate.js --documents 500000      (about 5.1 documents per parcel)
 *   node scripts/scale/generate.js --documents 500000 --files   (with their PDFs and text, API-810)
 *
 * The database is the load-test stack's (e2e/stack, E2E_API_PORT + 6), or SCALE_DATABASE_URL (never
 * DB_CONNECTION_STRING: the services' code loads backend/.env, the developer's own database).
 * The services must have started on it once, so their tables exist. Without --replace it refuses
 * a database that already holds documents or records. --files needs the stack started with
 * E2E_STORE_DIR: the files go into its encrypted directory, encrypted with its OpenBao (files.js).
 * --resume, with the same options, carries on a run that stopped: the batches already written are
 * built again (the same seed gives the same register) but not written.
 */
import {execFileSync} from 'node:child_process';
import {rmSync} from 'node:fs';
import {join} from 'node:path';
import {parseArgs} from 'node:util';
import pg from 'pg';
import {
  BAO_DIR,
  FILES_DIR,
  PORTS,
  STORE_DIR,
} from '../../../e2e/stack/config.mjs';
import {createFileWriter} from './files.js';
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
    // the generated files' first page and signature (--files)
    deedsHeading: ['REPUBLIC OF NAMIBIA', 'DEEDS REGISTRY'],
    registryTown: 'Windhoek',
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
    files: {type: 'boolean', default: false},
    resume: {type: 'boolean', default: false},
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

if (options.files && !STORE_DIR) {
  throw new Error(
    '--files needs the stack started with E2E_STORE_DIR, and the same E2E_STORE_DIR here',
  );
}

const TABLES = {
  documents: '"edrms"."document"',
  documentVersions: '"edrms"."document_version"',
  documentTexts: '"edrms"."document_text"',
  documentCounter: '"edrms"."counter"',
  records: '"records"."land_record"',
  recordVersions: '"records"."record_version"',
  recordCounter: '"records"."counter"',
  comments: '"records"."record_comment"',
};
/** Intake's tables, filled with --files (emptied by --replace either way). */
const INTAKE = {
  batches: '"intake"."batch"',
  documents: '"intake"."document"',
  extractions: '"intake"."extraction"',
  events: '"intake"."event"',
  jobs: '"intake"."job"',
  outbox: '"intake"."outbox"',
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
  if (batch.files) {
    await insert(client, TABLES.documentTexts, batch.files.edrmsTexts);
    await insert(client, INTAKE.batches, batch.files.intakeBatches);
    await insert(client, INTAKE.documents, batch.files.intakeDocuments);
    await insert(client, INTAKE.extractions, batch.files.intakeExtractions);
    await insert(client, INTAKE.events, batch.files.intakeEvents);
  }
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

/** Whether a batch is in the database already (--resume): its first document is. */
async function written(client, document) {
  const {rowCount} = await client.query(
    `SELECT 1 FROM ${TABLES.documents} WHERE "id" = $1`,
    [document.id],
  );
  return rowCount > 0;
}

/** What a folder takes on the disk, as du says it ("26G"). */
function diskUse(dir) {
  return execFileSync('du', ['-sh', dir], {encoding: 'utf8'}).split('\t')[0];
}

async function prepare(client) {
  const [{n: documents}] = (
    await client.query(`SELECT count(*)::int AS n FROM ${TABLES.documents}`)
  ).rows;
  const [{n: records}] = (
    await client.query(`SELECT count(*)::int AS n FROM ${TABLES.records}`)
  ).rows;
  if ((documents || records) && !options.replace && !options.resume) {
    throw new Error(
      `The database already holds ${documents} documents and ${records} records: --replace empties it first`,
    );
  }
  if (options.replace && !options.resume) {
    await client.query(
      `TRUNCATE ${Object.values(TABLES).join(', ')}, ${Object.values(INTAKE).join(', ')}, "edrms"."outbox", "records"."outbox"`,
    );
    await client.query(
      `DELETE FROM "intake"."counter" WHERE "key" LIKE 'batch:%'`,
    );
    if (STORE_DIR) {
      // the files of the register replaced; the encrypted directory itself stays
      for (const service of ['edrms', 'intake']) {
        rmSync(join(FILES_DIR, service), {recursive: true, force: true});
      }
    }
  }
}

const client = new pg.Client({
  connectionString:
    process.env.SCALE_DATABASE_URL ||
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
  const files = options.files
    ? createFileWriter({
        seed,
        profile,
        filesDir: FILES_DIR,
        baoAddr: `http://127.0.0.1:${PORTS.bao}`,
        baoDir: BAO_DIR,
      })
    : null;
  const totals = {documents: 0, versions: 0, records: 0, states: {}};
  const started = Date.now();
  let batch = null;
  let pending = Promise.resolve();
  /**
   * The batch's land records, once its documents are complete (with --files, their real files and
   * seals, which the records pin; a correction's version 2.0 is made from that version 1.0).
   */
  const buildRecords = () => {
    for (const {index, documents} of batch.parcels) {
      const built = recordsRandom.chance(recordShare)
        ? records.build(index, documents)
        : null;
      for (const {document, versions} of documents) {
        batch.documents.push(document);
        batch.documentVersions.push(...versions);
        totals.versions += versions.length;
      }
      if (built) {
        batch.records.push(built.record);
        batch.recordVersions.push(...built.versions);
        totals.records += 1;
        totals.states[built.state] = (totals.states[built.state] ?? 0) + 1;
      }
    }
  };
  const flush = async () => {
    if (
      options.resume &&
      (await written(client, batch.parcels[0].documents[0].document))
    ) {
      // written before the stop: only its place in the seed's sequence is taken
      files?.skip(batch.entries);
      buildRecords();
      batch = null;
      return;
    }
    if (files) batch.files = await files.add(batch.entries);
    buildRecords();
    await pending; // one batch in the database while the next one is built
    pending = writeBatch(client, batch);
    // a failure is thrown where it is awaited (the next batch, or the end), not lost meanwhile
    pending.catch(() => {});
    batch = null;
  };

  for (const {index, documents} of register.parcels()) {
    batch ??= {
      parcels: [],
      documents: [],
      documentVersions: [],
      records: [],
      recordVersions: [],
      entries: [],
    };
    batch.parcels.push({index, documents});
    batch.entries.push(...documents);
    totals.documents += documents.length;
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
  await files?.close();
  await writeCounters(client, TABLES.documentCounter, register.counters());
  if (files) {
    await client.query(
      `INSERT INTO "intake"."counter" ("key", "last") VALUES ($1, $2)
         ON CONFLICT ("key") DO UPDATE SET "last" = GREATEST("intake"."counter"."last", EXCLUDED."last")`,
      [`batch:${profile.registry}`, files.batchCount()],
    );
  }
  await writeCounters(client, TABLES.recordCounter, records.yearCounters());
  console.log('Analysing the tables…');
  for (const table of [
    TABLES.documents,
    TABLES.documentVersions,
    TABLES.records,
    TABLES.recordVersions,
    ...(files ? [TABLES.documentTexts, INTAKE.documents, INTAKE.events] : []),
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
        ...(files
          ? {files: {...files.totals(), onDisk: diskUse(FILES_DIR)}}
          : {}),
        seconds: Math.round((Date.now() - started) / 1000),
      },
      null,
      2,
    ),
  );
} finally {
  await client.end();
}

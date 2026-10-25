#!/usr/bin/env node
/**
 * Checks a random sample of the test register's files (API-810, generate.js --files), as the
 * ticket's "Done when" asks: each sampled document's file is ciphertext on the disk, decrypts,
 * opens as a PDF with its page count, and its text holds every field's value as filed and equals
 * the page text kept beside it; intake's copy is the same file. Then the services themselves open
 * it: edrms' integrity check (file hash and seal) and intake's reading for the search service;
 * and the land records that pin it hold its seal.
 *
 *   E2E_API_PORT=3600 E2E_STORE_DIR=<dir> node scripts/scale/check-files.js [--sample 200]
 *
 * Prints the counts and the first problems; exits 1 when any document fails.
 */
import {readFileSync} from 'node:fs';
import {open} from 'node:fs/promises';
import {join} from 'node:path';
import {parseArgs} from 'node:util';
import pg from 'pg';
import {PDFDocument, PDFArray, PDFRawStream, decodePDFRawStream} from 'pdf-lib';
import {createServiceTokenSigner} from '@lrfe/common';
import {
  createBaoKeyring,
  createEncryptingStore,
  createLocalStore,
} from '@lrfe/storage';
import {
  BAO_DIR,
  FILES_DIR,
  JWT_SECRET,
  PORTS,
  STORE_DIR,
} from '../../../e2e/stack/config.mjs';

const {values: options} = parseArgs({
  options: {sample: {type: 'string', default: '200'}},
});
if (!STORE_DIR) throw new Error("E2E_STORE_DIR: the stack's kept store");

/** WinAnsi bytes that differ from Latin-1 and occur in the register's text. */
const WIN_ANSI = {0x96: '–', 0x97: '—', 0x91: '‘', 0x92: '’'};

function store(service, keyName) {
  return createEncryptingStore(
    createLocalStore({root: join(FILES_DIR, service)}),
    createBaoKeyring({
      addr: `http://127.0.0.1:${PORTS.bao}`,
      roleId: readFileSync(
        join(BAO_DIR, 'approle', `${service}-role-id`),
        'utf8',
      ).trim(),
      secretIdFile: join(BAO_DIR, 'approle', `${service}-secret-id`),
      keyName,
    }),
  );
}

async function read(s, key, encryption) {
  const chunks = [];
  for await (const c of await s.getStream(key, {encryption})) chunks.push(c);
  return Buffer.concat(chunks);
}

/** The first bytes of the file as it lies on the disk. */
async function rawStart(service, key) {
  const file = await open(join(FILES_DIR, service, key));
  try {
    const {buffer} = await file.read(Buffer.alloc(8), 0, 8, 0);
    return buffer.toString('latin1');
  } finally {
    await file.close();
  }
}

/** Each page's text, a line per text operation (the generator writes a line at a time). */
function textOf(pdf) {
  return pdf.getPages().map(page => {
    const contents = page.node.Contents();
    const streams =
      contents instanceof PDFArray
        ? contents.asArray().map(r => pdf.context.lookup(r))
        : [contents];
    const ops = streams
      .map(s =>
        Buffer.from(
          s instanceof PDFRawStream
            ? decodePDFRawStream(s).decode()
            : s.getContents(),
        ).toString('latin1'),
      )
      .join('\n');
    return [...ops.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)]
      .map(m =>
        [...Buffer.from(m[1], 'hex')]
          .map(b => WIN_ANSI[b] ?? String.fromCharCode(b))
          .join(''),
      )
      .join('\n');
  });
}

/** A page's lines without the empty ones (an empty line draws nothing in the PDF). */
const lines = text => text.split('\n').filter(Boolean).join('\n');

async function call(port, path, token) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: {authorization: `Bearer ${token}`},
  });
  return {status: res.status, body: await res.json()};
}

const db = new pg.Client({
  connectionString:
    process.env.SCALE_DATABASE_URL ||
    `postgres://lrfe@127.0.0.1:${PORTS.postgres}/e2e`,
});
await db.connect();
const stores = {
  edrms: store('edrms', 'edrms-files'),
  intake: store('intake', 'intake-files'),
};
const audit = createServiceTokenSigner({secret: JWT_SECRET, service: 'audit'});
const search = createServiceTokenSigner({
  secret: JWT_SECRET,
  service: 'search',
});
const started = Date.now();
const problems = [];
let checked = 0;
try {
  const {rows: sample} = await db.query(
    `SELECT d."id", d."edrmsNo", d."pages", d."sourceId", d."currentVersion",
            t."storageKey" AS "textKey", t."encryption" AS "textEncryption"
       FROM "edrms"."document" d JOIN "edrms"."document_text" t ON t."documentId" = d."id"
      ORDER BY random() LIMIT $1`,
    [Number(options.sample)],
  );
  for (const doc of sample) {
    const fail = what => problems.push(`${doc.edrmsNo}: ${what}`);
    try {
      await check(doc, fail);
    } catch (err) {
      fail(`${err.code ?? err.name}: ${err.message}`);
    }
    checked += 1;
  }
} finally {
  await db.end();
}

/** One document's checks; `fail(what)` notes a problem. */
async function check(doc, fail) {
  const {rows: versions} = await db.query(
    `SELECT * FROM "edrms"."document_version" WHERE "documentId" = $1 ORDER BY "versionNumber"`,
    [doc.id],
  );
  const [first] = versions;
  const {
    rows: [scan],
  } = await db.query(`SELECT * FROM "intake"."document" WHERE "id" = $1`, [
    doc.sourceId,
  ]);
  if (!scan || scan.filedDocumentId !== doc.id) {
    fail('no intake document filed as it');
    return;
  }
  if ((await rawStart('edrms', first.storageKey)).startsWith('%PDF')) {
    fail('the stored file is not encrypted');
  }
  const plain = await read(stores.edrms, first.storageKey, first.encryption);
  const pdf = await PDFDocument.load(plain);
  if (pdf.getPageCount() !== doc.pages) {
    fail(`${pdf.getPageCount()} pages, the document says ${doc.pages}`);
  }
  const text = textOf(pdf);
  const kept = JSON.parse(
    (await read(stores.edrms, doc.textKey, doc.textEncryption)).toString(),
  );
  if (JSON.stringify(kept.map(p => lines(p.text))) !== JSON.stringify(text)) {
    fail("the page text kept in edrms is not the PDF's text");
  }
  const all = text.join('\n');
  for (const f of first.fields) {
    if (!all.includes(f.v)) fail(`"${f.label}" (${f.v}) is not in the text`);
  }
  const intakeCopy = await read(stores.intake, scan.fileKey, scan.encryption);
  if (!intakeCopy.equals(plain) || scan.sha256 !== first.sha256) {
    fail("intake's scan is not the filed file");
  }
  // the services open it themselves: every version's integrity, and the reading
  for (const v of versions) {
    const res = await call(
      PORTS.edrms,
      `/documents/${doc.id}/versions/${v.versionNumber}/verify`,
      audit(),
    );
    if (res.status !== 200 || !res.body.intact) {
      fail(
        `edrms' integrity check of ${v.label}: ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`,
      );
    }
  }
  const reading = await call(
    PORTS.intake,
    `/documents/${doc.sourceId}/reading`,
    search(),
  );
  if (
    reading.status !== 200 ||
    JSON.stringify(reading.body.pages?.map(p => lines(p.text))) !==
      JSON.stringify(text)
  ) {
    fail(`intake's reading: ${reading.status}`);
  }
  // the land records that pin it hold edrms' seal of the version they pin
  const {rows: pins} = await db.query(
    `SELECT p->>'seal' AS seal, (p->>'version')::int AS version
         FROM "records"."record_version" v, jsonb_array_elements(v."data"->'documents') p
        WHERE p->>'edrmsDocumentId' = $1`,
    [doc.id],
  );
  for (const pin of pins) {
    const pinned = versions.find(v => v.versionNumber === pin.version);
    if (pin.seal !== pinned?.seal) {
      fail(`a land record pins version ${pin.version} with another seal`);
    }
  }
}
const failed = new Set(problems.map(p => p.split(':')[0])).size;
console.log(
  JSON.stringify(
    {
      sampled: checked,
      failed,
      problems: problems.slice(0, 10),
      seconds: Math.round((Date.now() - started) / 1000),
    },
    null,
    2,
  ),
);
process.exit(failed ? 1 : 0);
